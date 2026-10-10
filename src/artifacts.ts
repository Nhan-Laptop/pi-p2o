import type { OutputObserver, OutputStream } from './process.js';
import type { ScratchSnapshot } from './scratch.js';

export interface ArtifactReceipt {
  id: string; stream: OutputStream; totalBytes: number; capturedInputBytes: number; bytes: number;
  sha256: string; truncated: boolean; captureOutcome: 'returned' | 'interrupted'; offset?: number;
}
export interface CaptureReceipt {
  available: boolean; maxBytes: number; observedBytes: number; capturedBytes: number;
  artifacts: ArtifactReceipt[];
  warning?: string; source?: ScratchSnapshot;
}
export type CapturedPart = { stream: OutputStream; input: Buffer; totalBytes: number };

/** Host-only, operation-owned prefixes. Never attach this object or its buffers to a tool/RPC result.
 * Two fixed buffers avoid unbounded per-chunk descriptors, even for byte-at-a-time or endless output.
 * Their combined used bytes are capped; allocation is at most 2*maxBytes and starts only on data.
 * Byte order is preserved within each stream, not claimed across stdout/stderr or HTTP hops.
 */
export class OutputCapture {
  #maxBytes: number;
  #available = false;
  #closed = false;
  #used = 0;
  #streams: Record<OutputStream, {buffer?: Buffer; used: number; total: number}> = {
    stdout: {used: 0, total: 0}, stderr: {used: 0, total: 0},
  };
  constructor(maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw Error('Capture bound must be 1 byte..8 MiB');
    this.#maxBytes = maxBytes;
  }
  /** Empty stdout announces a runner that actually supports observation, including empty results. */
  readonly observe: OutputObserver = (stream, input) => {
    if (this.#closed) throw Error('Output capture is closed');
    if (!['stdout', 'stderr'].includes(stream) || !Buffer.isBuffer(input)) throw Error('Invalid output observation');
    this.#available = true;
    const state = this.#streams[stream];
    if (!Number.isSafeInteger(this.#streams.stdout.total + this.#streams.stderr.total + input.length)) throw Error('Observed output byte count exceeds safe representation');
    state.total += input.length;
    const length = Math.min(input.length, this.#maxBytes - this.#used);
    if (!length) return;
    state.buffer ??= Buffer.allocUnsafe(this.#maxBytes);
    input.copy(state.buffer, state.used, 0, length);
    state.used += length; this.#used += length;
  };
  receipt(): CaptureReceipt {
    if (this.#closed) throw Error('Output capture is closed');
    return {available: this.#available, maxBytes: this.#maxBytes, observedBytes: this.#streams.stdout.total + this.#streams.stderr.total,
      capturedBytes: this.#used, artifacts: [], ...(!this.#available ? {warning: 'Runner supplied no pre-truncation stream; missing bytes cannot be reconstructed.'} : {})};
  }
  /** Borrowed slices are valid until dispose(); consumed synchronously by the owner store only. */
  parts(): CapturedPart[] {
    if (this.#closed) throw Error('Output capture is closed');
    return (['stdout', 'stderr'] as const).filter(stream => this.#streams[stream].total > 0).map(stream => {
      const state = this.#streams[stream];
      return {stream, input: state.buffer?.subarray(0, state.used) ?? Buffer.alloc(0), totalBytes: state.total};
    });
  }
  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const state of Object.values(this.#streams)) {state.buffer?.fill(0); state.buffer = undefined;}
  }
}

/** Redact a captured prefix before persistent publication, including a cut-off PEM private key.
 * Standard redaction remains best effort; unknown formats/binary data are not declared secret-free.
 */
export function redactArtifactPrefix(value: string, redact: (value: string) => string): string {
  return redact(value).replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*$/g, '[REDACTED INCOMPLETE PRIVATE KEY]');
}

/** Borrowed prefix of an already-valid UTF-8 buffer; do not split a redaction-expanded codepoint. */
export function utf8Prefix(input:Buffer,maxBytes:number):Buffer{
  if(!Buffer.isBuffer(input)||!Number.isSafeInteger(maxBytes)||maxBytes<0)throw Error('Invalid UTF-8 prefix bound');
  let end=Math.min(input.length,maxBytes);if(end<input.length)while(end>0&&(input[end]&0xc0)===0x80)end--;
  return input.subarray(0,end);
}

/** A selected segment is not a fresh document. Do not expose a credential/header value whose
 * key is outside it. Context is bounded and contains flags only, never preceding secret bytes.
 * Unknown older context is still best effort: suppress secret-compatible base64 lines and label
 * partial rather than promising that arbitrary formats/earlier private-key ancestry were found.
 */
export function redactScratchSegment(value:string,source:ScratchSnapshot,redact:(value:string)=>string):{text:string;partial:boolean;reason?:string}{
  const context=source.redactionContext,unknown=source.offset>0&&(!context||context.privateKey==='unknown');let partial=unknown;
  if(!value)return {text:'',partial,...(unknown?{reason:'Scratch redaction context exceeds bounded history; unknown context, best effort only'}:{})};
  if(context?.privateKey==='open'){
    const end=/-----END [^-\r\n]*PRIVATE KEY-----/.exec(value);
    value='[REDACTED PRIVATE KEY CONTINUATION]'+(end?value.slice(end.index+end[0].length):'');partial=true;
  }else if(source.offset>0&&(!context||context.leadingFragment)){
    value=value.replace(/^[^\r\n]*(?:\r\n|\r|\n|$)/,'[REDACTED LEADING LINE FRAGMENT]\n');partial=true;
  }
  if(unknown)value=value.replace(/(^|\n)[ \t]*[A-Za-z0-9+/]+={0,2}[ \t]*(?=\r?(?:\n|$))/g,'$1[REDACTED UNKNOWN BASE64 CONTEXT]');
  return {text:redactArtifactPrefix(value,redact),partial,...(partial?{reason:unknown?'Scratch redaction context exceeds bounded history; unknown context, best effort only':'Scratch boundary fragment redacted; selected bytes are not a standalone document'}:{})};
}
