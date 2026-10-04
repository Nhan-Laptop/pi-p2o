// Fixture: strict header-value canonicalizer. Valid UTF-8 only; control characters are rejected.
// It deliberately disagrees with the lenient implementation on NUL/CR/LF and on invalid UTF-8.
export function outcome(raw) {
  const value = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new TypeError('strict-reject');
  return value.trim();
}
