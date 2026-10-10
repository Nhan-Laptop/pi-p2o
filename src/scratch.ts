import { createHash } from 'node:crypto';

export const SCRATCH_PROTOCOL_BYTES = 8192;
export const SCRATCH_MAX_BYTES = 8 * 1024 * 1024;
export const SCRATCH_MAX_OFFSET = 1024 * 1024 * 1024;
export const SCRATCH_REDACTION_CONTEXT_BYTES = 8192;
export interface ScratchRedactionContext { bytes:number; leadingFragment:boolean; privateKey:'none'|'open'|'unknown' }
export interface ScratchStat { size: number; device: string; inode: string; mtimeNs: string; ctimeNs: string; links: number }
/** Observation inside the sandbox, not an atomic filesystem snapshot or execution authority. */
export interface ScratchSnapshot {
  version: 1 | 2; path: string; root: string; totalBytes: number; offset: number; capturedBytes: number;
  prefixSha256: string; before: ScratchStat; after: ScratchStat; stable: boolean;
  encoding: 'utf8-prefix'; redactionContext?:ScratchRedactionContext;
}
export function scratchPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 2048 || Buffer.byteLength(value) > 2048
    || value.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(value) || Buffer.from(value).toString('utf8') !== value) throw Error('Scratch path must be a relative UTF-8 path within assigned scratch (1..2048 bytes)');
  const components = value.split('/');
  if (components.length > 32 || components.some(v => !v || v === '.' || v === '..' || Buffer.byteLength(v) > 255)) throw Error('Scratch path contains traversal/empty/oversized components');
  return value; // No URL decode, Unicode normalization, shell expansion or host realpath.
}
export function scratchRoot(value: unknown): string {
  if (value !== '/work' && (typeof value !== 'string' || !/^\/work\/[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(value))) throw Error('Invalid owner-assigned scratch root');
  return value as string;
}
export function scratchBound(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > SCRATCH_MAX_BYTES) throw Error('Scratch capture bound must be 1 byte..8 MiB');
  return Number(value);
}
/** Byte offset for segment capture of one scratch file; bounded so a huge file cannot be walked blindly. */
export function scratchOffset(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > SCRATCH_MAX_OFFSET) throw Error('Scratch offset must be an integer 0..1 GiB');
  return Number(value);
}
const sameStat = (a: ScratchStat, b: ScratchStat) => ['size','device','inode','mtimeNs','ctimeNs','links'].every(key => a[key as keyof ScratchStat] === b[key as keyof ScratchStat]);
/** Strict metadata shape and byte/hash binding, independently of the 48 KiB display excerpt. */
export function parseScratchSnapshot(input: Buffer, expected: {path:string;root:string;maxBytes:number;offset:number;observedBytes:number;sha256:string}): ScratchSnapshot {
  if (!input.length || input.length > SCRATCH_PROTOCOL_BYTES) throw Error('Scratch protocol missing/oversized; capture incomplete');
  const value = JSON.parse(input.toString('utf8'));
  if (value?.ok === false) throw Error(`Scratch capture denied (${typeof value.error === 'string' && /^[A-Z_]{1,40}$/.test(value.error) ? value.error : 'INVALID_ERROR'}); no file was imported`);
  validateScratchSnapshot(value);
  if (value.path !== expected.path || value.root !== expected.root || value.offset !== expected.offset || value.capturedBytes !== expected.observedBytes || value.capturedBytes > expected.maxBytes || value.prefixSha256 !== expected.sha256) throw Error('Scratch protocol identity/byte/hash mismatch; capture incomplete');
  return value;
}
export function validateScratchSnapshot(value: unknown): asserts value is ScratchSnapshot {
  const v = value as ScratchSnapshot;
  const keys=v?.version===2?'after,before,capturedBytes,encoding,offset,path,prefixSha256,redactionContext,root,stable,totalBytes,version':'after,before,capturedBytes,encoding,offset,path,prefixSha256,root,stable,totalBytes,version';
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== keys
    || ![1,2].includes(v.version) || v.encoding !== 'utf8-prefix' || typeof v.stable !== 'boolean' || !/^[a-f0-9]{64}$/.test(v.prefixSha256)
    || !Number.isSafeInteger(v.totalBytes) || v.totalBytes < 0 || !Number.isSafeInteger(v.offset) || v.offset < 0 || v.offset > SCRATCH_MAX_OFFSET
    || !Number.isSafeInteger(v.capturedBytes) || v.capturedBytes < 0 || v.capturedBytes > SCRATCH_MAX_BYTES || v.offset + v.capturedBytes > v.totalBytes) throw Error('Invalid scratch snapshot metadata');
  scratchPath(v.path); scratchRoot(v.root);
  if(v.version===2){const c=v.redactionContext;if(!c||Object.keys(c).sort().join(',')!=='bytes,leadingFragment,privateKey'||!Number.isSafeInteger(c.bytes)||c.bytes!==Math.min(v.offset,SCRATCH_REDACTION_CONTEXT_BYTES)||typeof c.leadingFragment!=='boolean'||!['none','open','unknown'].includes(c.privateKey)
    ||v.offset===0&&(c.leadingFragment||c.privateKey!=='none')||c.privateKey==='unknown'&&c.bytes===v.offset)throw Error('Invalid scratch redaction context');}
  for (const s of [v.before,v.after]) {
    if (!s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).sort().join(',') !== 'ctimeNs,device,inode,links,mtimeNs,size'
      || !Number.isSafeInteger(s.size) || s.size < 0 || !Number.isSafeInteger(s.links) || s.links < 0
      || [s.device,s.inode,s.mtimeNs,s.ctimeNs].some(n => typeof n !== 'string' || !/^-?\d{1,40}$/.test(n))) throw Error('Invalid scratch stat metadata');
  }
  if (v.totalBytes !== v.before.size || v.before.links !== 1 || v.stable !== sameStat(v.before,v.after)) throw Error('Scratch snapshot inconsistent with stat observations');
}
export const scratchPrefixHash = (input: Buffer) => createHash('sha256').update(input).digest('hex');

/** Fixed isolated Python stdlib reader. Args are JSON data; file bytes never become executable code.
 * Production root is constrained to /work[/actor]; tests can run this exact script against a disposable
 * directory by supplying a fixture root. Never exposed as a model-selectable script/interpreter.
 * Open pinned directories and final regular single-link file with NOFOLLOW/NONBLOCK, bound text prefix,
 * observe before/after stat, emit one bounded metadata frame on stderr and raw bytes on stdout.
 */
export const SCRATCH_READER = String.raw`
import codecs, hashlib, json, os, re, stat, sys
handles = []
def denied(code):
    sys.stderr.write(json.dumps({"ok": False, "error": code}) + "\n")
    sys.stderr.flush()
    raise SystemExit(78)
def info(s):
    return {"size": s.st_size, "device": str(s.st_dev), "inode": str(s.st_ino), "mtimeNs": str(s.st_mtime_ns), "ctimeNs": str(s.st_ctime_ns), "links": s.st_nlink}
try:
    q = json.loads(sys.argv[1])
    root, path, cap, offset = q["root"], q["path"], q["maxBytes"], q["offset"]
    parts = path.split("/")
    if not isinstance(cap, int) or isinstance(cap, bool) or cap < 1 or cap > 8388608: denied("INVALID_BOUND")
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0 or offset > 1073741824: denied("INVALID_OFFSET")
    if not path or len(path.encode("utf8")) > 2048 or len(parts) > 32 or any(p in ("", ".", "..") or len(p.encode("utf8")) > 255 for p in parts) or path.startswith("/") or "\\" in path or any(ord(c) < 32 or ord(c) == 127 for c in path): denied("INVALID_PATH")
    dflags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    # Pin every root ancestor too; no unvalidated intermediate symlink.
    current = os.open("/", dflags); handles.append(current)
    for p in root.split("/")[1:]:
        if not p or p in (".", ".."): denied("INVALID_ROOT")
        current = os.open(p, dflags, dir_fd=current); handles.append(current)
    for p in parts[:-1]:
        current = os.open(p, dflags, dir_fd=current); handles.append(current)
    fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=current); handles.append(fd)
    initial = os.fstat(fd)
    if not stat.S_ISREG(initial.st_mode) or initial.st_nlink != 1 or initial.st_size < 0 or initial.st_size > 9007199254740991: denied("NOT_SINGLE_LINK_REGULAR_FILE")
    if offset > initial.st_size: denied("OFFSET_BEYOND_EOF")
    context = os.pread(fd, min(offset, 8192), max(0, offset - 8192))
    if len(context) != min(offset, 8192): denied("FILE_CHANGED_DURING_CAPTURE")
    markers = list(re.finditer(rb"-----(BEGIN|END) [^-\r\n]*PRIVATE KEY-----", context))
    private_key = ("open" if markers[-1].group(1) == b"BEGIN" else "none") if markers else ("none" if len(context) == offset else "unknown")
    redaction_context = {"bytes": len(context), "leadingFragment": offset > 0 and context[-1:] not in (b"\n", b"\r"), "privateKey": private_key}
    os.lseek(fd, offset, os.SEEK_SET)
    data = bytearray()
    while len(data) < cap:
        chunk = os.read(fd, min(65536, cap - len(data)))
        if not chunk: break
        data.extend(chunk)
    # Validate exactly the bytes emitted. An incomplete non-EOF codepoint is not consumed:
    # the next segment starts at offset + capturedBytes, never at the configured cap.
    if any(c < 9 or (13 < c < 32 and c != 27) or c == 127 for c in data): denied("BINARY_PREFIX_DENIED")
    try:
        decoder = codecs.getincrementaldecoder("utf8")("strict")
        decoder.decode(data, final=offset + len(data) >= initial.st_size)
        pending = decoder.getstate()[0]
        if pending:
            del data[-len(pending):]
            if not data: denied("UTF8_BOUND_TOO_SMALL")
    except UnicodeDecodeError: denied("INVALID_UTF8_PREFIX")
    # A marker may begin before offset and finish inside this segment. The small lookahead
    # uses already captured bytes; it does not increase the capture bound or expose context.
    crossing = [m for m in re.finditer(rb"-----(BEGIN|END) [^-\r\n]*PRIVATE KEY-----", context + bytes(data[:128])) if m.start() < len(context)]
    if crossing: redaction_context["privateKey"] = "open" if crossing[-1].group(1) == b"BEGIN" else "none"
    final = os.fstat(fd)
    before, after = info(initial), info(final)
    if offset + len(data) > initial.st_size: denied("FILE_CHANGED_DURING_CAPTURE")
    result = {"version": 2, "path": path, "root": root, "totalBytes": initial.st_size, "offset": offset, "capturedBytes": len(data), "prefixSha256": hashlib.sha256(data).hexdigest(), "before": before, "after": after, "stable": before == after, "encoding": "utf8-prefix", "redactionContext": redaction_context}
    encoded = (json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf8")
    if len(encoded) > 8192: denied("METADATA_TOO_LARGE")
    sys.stderr.buffer.write(encoded); sys.stderr.buffer.flush()
    sys.stdout.buffer.write(data); sys.stdout.buffer.flush()
except (OSError, ValueError, TypeError, KeyError, IndexError, UnicodeError):
    denied("FILE_OR_PATH_REJECTED")
finally:
    for fd in reversed(handles):
        try: os.close(fd)
        except OSError: pass
`;
