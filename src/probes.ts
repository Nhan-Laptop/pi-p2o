import type { ProcessResult } from './process.js';
import type { CapabilitySnapshot } from './capabilities.js';

/** Fixed offline checks, never a provider or registry request. Success requires exercising behavior. */
export const PROBES = {
  python: `python3 -c 'import json, sqlite3; c=sqlite3.connect(":memory:"); assert c.execute("select 2+2").fetchone()[0]==4; print("P2O_PYTHON_OK")'`,
  semgrep: `set -eu
export PATH=/usr/local/bin:/usr/bin:/bin
command -v semgrep >/dev/null 2>&1 || { echo 'P2O_SEMGREP_NOT_INSTALLED' >&2; exit 127; }
p=$(mktemp -d /work/p2o-probe-XXXXXX)
trap 'rm -rf "$p"' EXIT
printf '%s\\n' 'rules:' '  - id: p2o-probe' '    languages: [python]' '    message: local probe' '    severity: INFO' '    pattern: eval(...)' > "$p/rule.yml"
printf '%s\\n' 'eval(user_input)' > "$p/input.py"
SEMGREP_SEND_METRICS=off SEMGREP_ENABLE_VERSION_CHECK=0 semgrep scan --config "$p/rule.yml" --metrics=off --disable-version-check --jobs 1 --timeout 5 --max-memory 256 --json --quiet "$p/input.py" > "$p/result.json"
python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); assert len(r["results"])==1; print("P2O_SEMGREP_OK")' "$p/result.json"`,
} as const;
export function applyProbe(snapshot: CapabilitySnapshot, name: keyof typeof PROBES, result: ProcessResult): void {
  const c = snapshot.capabilities.find(c => c.id === `tool.${name}`)!;
  c.availability = result.code === 0 && result.stdout.includes(`P2O_${name.toUpperCase()}_OK`) ? 'supported' : 'unavailable';
  c.reason = c.availability === 'supported' ? 'Bounded offline functional probe passed in this run' : result.code === 127 ? 'Tool not installed on the sandbox system PATH' : 'Bounded offline functional probe failed in this run';
  c.evidence = result.evidenceId;
}
