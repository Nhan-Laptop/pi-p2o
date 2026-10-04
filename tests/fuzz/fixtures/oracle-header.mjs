// Fixture: one implementation plus an invariant. The canonicalizer silently truncates at the first
// semicolon (a real class of bug); the invariant states that accepted output may only drop whitespace
// bytes, so any silent truncation is reported as a violation.
const decode = raw => new TextDecoder('utf-8', { fatal: false }).decode(raw);
const withoutWhitespace = value => value.replace(/\s+/g, '');

export function outcome(raw) {
  const value = decode(raw);
  const cut = value.indexOf(';');
  return (cut >= 0 ? value.slice(0, cut) : value).trim();
}

export function invariant(raw) {
  let result;
  try { result = outcome(raw); } catch { return true; } // ordinary rejection is a legitimate outcome
  return withoutWhitespace(result).length < withoutWhitespace(decode(raw)).length
    ? 'canonicalizer dropped non-whitespace bytes (possible silent truncation)'
    : true;
}
