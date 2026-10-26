/**
 * Operator-supplied identity and secret material.
 *
 * The operator points at one bounded JSON file on the host. The extension validates it, seals a private copy inside the
 * control directory, and exposes only ids, kinds, labels and scopes to the model. Values are substituted at the dispatch seam
 * and redacted from retained bytes; nothing in this module logs or returns a value by accident.
 */
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export const SECRET_KINDS = ['password', 'token', 'api-key', 'cookie', 'private-key', 'basic-auth', 'header', 'other'] as const;
export type SecretKind = typeof SECRET_KINDS[number];

export interface IdentitySecret {
  id: string;
  kind: SecretKind;
  value: string;
  label?: string;
  scope?: string;
}

export interface IdentityFile {
  secrets: IdentitySecret[];
}

/** Model-safe projection: deliberately has no `value` field. */
export interface SecretView {
  id: string;
  kind: SecretKind;
  label?: string;
  scope?: string;
}

const MAX_SECRETS = 256;
const MAX_IDENTITY_BYTES = 64 * 1024;
const MAX_VALUE_BYTES = 65536;
const MAX_TEXT_CHARS = 200;
const SECRET_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TEXT_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const SECRET_FIELDS = ['id', 'kind', 'value', 'label', 'scope'] as const;
const BY_ID = (left: { id: string }, right: { id: string }): number => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

/** Host-only digest helper shared by sealing and retention checks. */
export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

const plainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const textField = (value: unknown, id: string, field: 'label' | 'scope'): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > MAX_TEXT_CHARS || TEXT_CONTROL.test(value)) {
    throw new Error(`Secret "${id}" ${field} must be a string of at most ${MAX_TEXT_CHARS} characters without control characters`);
  }
  return value;
};

/** Parse an already-decoded JSON value. Nothing is trimmed or rewritten; malformed input throws with the field or id named. */
export function parseIdentity(raw: unknown): IdentityFile {
  if (!plainObject(raw)) throw new Error('Identity must be an object');
  for (const key of Object.keys(raw)) {
    if (key !== 'secrets') throw new Error(`Unknown identity field: ${key}`);
  }
  const rows = raw.secrets;
  if (!Array.isArray(rows)) throw new Error('Identity secrets must be an array');
  if (rows.length === 0) throw new Error('Identity secrets must be a non-empty array');
  if (rows.length > MAX_SECRETS) throw new Error(`Identity secrets must contain at most ${MAX_SECRETS} entries`);

  const secrets: IdentitySecret[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < rows.length; index++) {
    const row: unknown = rows[index];
    if (!plainObject(row)) throw new Error(`Secret at index ${index} must be an object`);
    const id = row.id;
    if (typeof id !== 'string' || !SECRET_ID.test(id)) {
      throw new Error(`Invalid secret id at index ${index}: expected 1..64 characters of [a-z0-9-] starting with a letter or digit`);
    }
    for (const key of Object.keys(row)) {
      if (!(SECRET_FIELDS as readonly string[]).includes(key)) throw new Error(`Secret "${id}" has unknown field: ${key}`);
    }
    if (ids.has(id)) throw new Error(`Duplicate secret id: ${id}`);
    ids.add(id);

    const kind = row.kind;
    if (typeof kind !== 'string' || !(SECRET_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`Secret "${id}" kind must be one of: ${SECRET_KINDS.join(', ')}`);
    }
    const value = row.value;
    if (typeof value !== 'string') throw new Error(`Secret "${id}" value must be a string`);
    if (value.includes('\u0000')) throw new Error(`Secret "${id}" value must not contain NUL`);
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes < 1 || bytes > MAX_VALUE_BYTES) throw new Error(`Secret "${id}" value must be 1..${MAX_VALUE_BYTES} UTF-8 bytes`);

    const label = textField(row.label, id, 'label');
    const scope = textField(row.scope, id, 'scope');
    const secret: IdentitySecret = { id, kind: kind as SecretKind, value };
    if (label !== undefined) secret.label = label;
    if (scope !== undefined) secret.scope = scope;
    secrets.push(secret);
  }
  return { secrets };
}

/** Host-only read: absolute path, regular file (lstat, so no symlink), bounded size, strict UTF-8, then the strict parser. */
export async function loadIdentityFile(path: string): Promise<IdentityFile> {
  if (!isAbsolute(path)) throw new Error('Identity path must be absolute');
  const info = await lstat(path);
  if (!info.isFile()) throw new Error('Identity file must be a regular file (symlinks are not followed)');
  if (info.size > MAX_IDENTITY_BYTES) throw new Error(`Identity file must be at most ${MAX_IDENTITY_BYTES} bytes`);
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_IDENTITY_BYTES) throw new Error(`Identity file must be at most ${MAX_IDENTITY_BYTES} bytes`);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Identity file must be valid UTF-8');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Identity file must contain valid JSON');
  }
  return parseIdentity(raw);
}

/**
 * Seal the parsed identity (never the raw bytes) as canonical JSON inside `<controlDir>/identity/identity.json` (0600).
 * The returned receipt names no value.
 */
export async function sealIdentity(path: string, controlDir: string): Promise<{ path: string; sha256: string; count: number }> {
  const identity = await loadIdentityFile(path);
  const directory = join(resolve(controlDir), 'identity');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const target = join(directory, 'identity.json');
  const body = JSON.stringify(identity);
  await writeFile(target, body, { mode: 0o600 });
  await chmod(target, 0o600);
  return { path: target, sha256: sha256Hex(body), count: identity.secrets.length };
}

/** Host-only lookup by id. Parsed identities are already unique; a later duplicate would only be hand-built input. */
export function secretIndex(identity: IdentityFile): Map<string, IdentitySecret> {
  const index = new Map<string, IdentitySecret>();
  for (const secret of identity.secrets) index.set(secret.id, secret);
  return index;
}

/** Deterministic model-safe list, sorted by id and without values. */
export function secretViews(identity: IdentityFile): SecretView[] {
  return [...identity.secrets].sort(BY_ID).map(secret => {
    const view: SecretView = { id: secret.id, kind: secret.kind };
    if (secret.label !== undefined) view.label = secret.label;
    if (secret.scope !== undefined) view.scope = secret.scope;
    return view;
  });
}

/** One bounded line naming only ids, kinds and labels/scopes; never a value. */
export function identitySummary(identity: IdentityFile): string {
  const views = secretViews(identity);
  const entries = views.map(view => {
    const note = view.label !== undefined ? view.label : view.scope;
    return `${view.kind}:${view.id}${note === undefined ? '' : ` (${note})`}`;
  });
  const summary = `${views.length} secret(s)${entries.length ? `: ${entries.join(', ')}` : ''}`;
  return summary.length > MAX_TEXT_CHARS ? `${summary.slice(0, MAX_TEXT_CHARS - 1)}…` : summary;
}

/**
 * Replace `${P2O_SECRET:<id>}` placeholders with raw values. The replacement is literal, not a replacement pattern; an
 * unknown id fails closed and `used` is the deduplicated, sorted list of ids that were actually substituted.
 */
export function substituteSecrets(text: string, identity: IdentityFile): { text: string; used: string[] } {
  const secrets = secretIndex(identity);
  const used = new Set<string>();
  const expanded = text.replace(/\$\{P2O_SECRET:([^}]*)\}/g, (_placeholder: string, id: string) => {
    const secret = secrets.get(id);
    if (!secret) throw new Error(`Unknown secret id: ${id}`);
    used.add(id);
    return secret.value;
  });
  return { text: expanded, used: [...used].sort() };
}

/**
 * Shell quoting is one POSIX word: `'value'` with each embedded quote escaped as `'\''`. The placeholder itself has to be a
 * standalone word: before it must be start/whitespace/`=:;|&(`, after it end/whitespace/`);|&><`, and it must not sit inside
 * a single- or double-quoted region.
 */
const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

const quoteStates = (text: string): Uint8Array => {
  const states = new Uint8Array(text.length + 1);
  let state = 0; // 0 = unquoted, 1 = single-quoted, 2 = double-quoted
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    states[index] = state;
    const char = text[index];
    if (state === 1) {
      if (char === "'") state = 0;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (state === 2) {
      if (char === '"') state = 0;
      continue;
    }
    if (char === "'") state = 1;
    else if (char === '"') state = 2;
  }
  states[text.length] = state;
  return states;
};

const shellBefore = (char: string | undefined): boolean => char === undefined || /\s/.test(char) || '=:;|&('.includes(char);
const shellAfter = (char: string | undefined): boolean => char === undefined || /\s/.test(char) || ');|&><'.includes(char);

export function substituteShellSecrets(text: string, identity: IdentityFile): { text: string; used: string[] } {
  const secrets = secretIndex(identity);
  const states = quoteStates(text);
  const used = new Set<string>();
  const expanded = text.replace(/\$\{P2O_SECRET:([^}]*)\}/g, (placeholder: string, id: string, offset: number) => {
    const before = offset === 0 ? undefined : text[offset - 1];
    const after = offset + placeholder.length >= text.length ? undefined : text[offset + placeholder.length];
    if (states[offset] !== 0 || !shellBefore(before) || !shellAfter(after)) {
      throw new Error('Secret placeholder must be a standalone shell word');
    }
    const secret = secrets.get(id);
    if (!secret) throw new Error(`Unknown secret id: ${id}`);
    used.add(id);
    return shellQuote(secret.value);
  });
  return { text: expanded, used: [...used].sort() };
}

/**
 * Replace exact value bytes, longest first (so a shorter overlapping value cannot leave a suffix). Values under 4 bytes are
 * not redacted. Existing `[REDACTED:<id>]` markers are protected, which makes a second pass a no-op.
 */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function redactSecrets(text: string, identity: IdentityFile): { text: string; replaced: number } {
  const values = identity.secrets
    .filter(secret => Buffer.byteLength(secret.value, 'utf8') >= 4)
    .sort((left, right) => Buffer.byteLength(right.value, 'utf8') - Buffer.byteLength(left.value, 'utf8') || BY_ID(left, right));
  if (!values.length) return { text, replaced: 0 };
  const byValue = new Map<string, string>();
  for (const secret of values) if (!byValue.has(secret.value)) byValue.set(secret.value, secret.id);
  // One alternation pass over the original text means a marker created here is never scanned again.
  const pattern = new RegExp([...byValue.keys()].map(escapeRegExp).join('|'), 'g');

  // Split around existing markers so redaction is idempotent even when a value is a substring of a marker.
  const segments: Array<{ text: string; protected: boolean }> = [];
  let cursor = 0;
  for (const match of text.matchAll(/\[REDACTED:[^\]]*\]/g)) {
    const start = match.index ?? 0;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), protected: false });
    segments.push({ text: match[0], protected: true });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), protected: false });

  let replaced = 0;
  for (const segment of segments) {
    if (segment.protected) continue;
    segment.text = segment.text.replace(pattern, match => {
      replaced += 1;
      return `[REDACTED:${byValue.get(match) ?? 'unknown'}]`;
    });
  }
  return { text: segments.map(segment => segment.text).join(''), replaced };
}

/** Leak scan: the first id (in file order) whose exact value of 4+ bytes appears in `text`. */
export function containsSecretValue(text: string, identity: IdentityFile): string | undefined {
  for (const secret of identity.secrets) {
    if (Buffer.byteLength(secret.value, 'utf8') >= 4 && text.includes(secret.value)) return secret.id;
  }
  return undefined;
}

/**
 * Retained artifacts are bytes: a capture may be binary and a value may straddle a chunk boundary. Valid UTF-8 uses the
 * exact-value text redactor (marker-protected and idempotent). Anything else is redacted in a one-to-one latin1 view, where
 * every character is exactly one byte, so the replacement is still exact and an existing marker is protected the same way.
 */
export function redactSecretBytes(input: Buffer, identity: IdentityFile): { bytes: Buffer; replaced: number } {
  if (!Buffer.isBuffer(input) || !input.length) return { bytes: input, replaced: 0 };
  let text: string | undefined;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(input); }
  catch { text = undefined; }
  if (text !== undefined) {
    const redacted = redactSecrets(text, identity);
    return redacted.replaced ? { bytes: Buffer.from(redacted.text, 'utf8'), replaced: redacted.replaced } : { bytes: input, replaced: 0 };
  }
  const latin1: IdentityFile = { secrets: identity.secrets.map(secret => ({ ...secret, value: Buffer.from(secret.value, 'utf8').toString('latin1') })) };
  const redacted = redactSecrets(input.toString('latin1'), latin1);
  return redacted.replaced ? { bytes: Buffer.from(redacted.text, 'latin1'), replaced: redacted.replaced } : { bytes: input, replaced: 0 };
}
