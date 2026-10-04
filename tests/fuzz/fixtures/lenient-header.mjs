// Fixture: lenient header-value canonicalizer. Invalid UTF-8 is replaced and NUL bytes are stripped,
// which is exactly the divergence the differential pack must find and shrink.
export function outcome(raw) {
  const value = new TextDecoder('utf-8', { fatal: false }).decode(raw);
  return value.replace(/\u0000/g, '').trim();
}
