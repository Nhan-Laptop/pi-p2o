import { it, expect } from 'vitest';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Sandbox } from '../../src/sandbox.js';
import { PROBES } from '../../src/probes.js';

it.skipIf(!process.env.P2O_TEST_TOOL_IMAGE)('offline selected image: actual vendored recipe finds five candidates and zero fixed matches', async () => {
  const target = await mkdtemp(join(tmpdir(), 'p2o-recipe-'));
  const image = process.env.P2O_TEST_TOOL_IMAGE!;
  await writeFile(join(target, 'README.txt'), 'Synthetic scanner regression, no execution of the example calls.');
  const sandbox = new Sandbox({ kind: 'directory', path: target }, undefined, undefined, { image, runId: 'p2o-recipe-test' });
  try {
    await sandbox.start();
    const probe = await sandbox.exec(PROBES.semgrep, 60);
    expect(probe.code, probe.stderr).toBe(0);
    expect(probe.stdout).toContain('P2O_SEMGREP_OK');
    const rules = await readFile(resolve('skills/source-code-auditing/recipes/semgrep-rules/p2o-python-offline.yaml'));
    const vulnerable = 'import subprocess,pickle,yaml,requests\nsubprocess.run(user_value, shell=True)\npickle.loads(user_value)\nyaml.load(user_value)\neval(user_value)\nrequests.get(user_value)\n';
    const fixed = 'import subprocess,json,yaml,requests\nsubprocess.run(["echo", user_value], shell=False)\njson.loads(user_value)\nyaml.safe_load(user_value)\nint(user_value)\nrequests.get(user_value,timeout=2)\n';
    const setup = [['rule.yaml', rules.toString('base64')], ['vulnerable.py', Buffer.from(vulnerable).toString('base64')], ['fixed.py', Buffer.from(fixed).toString('base64')]];
    const command = `python3 - <<'PY'\nimport base64\nfor name,data in ${JSON.stringify(setup)}: open('/work/'+name,'wb').write(base64.b64decode(data))\nPY\nSEMGREP_SEND_METRICS=off SEMGREP_ENABLE_VERSION_CHECK=0 semgrep scan --config /work/rule.yaml --metrics=off --disable-version-check --jobs 1 --timeout 10 --max-memory 256 --json --quiet --no-git-ignore /work/vulnerable.py /work/fixed.py > /work/results.json\npython3 - <<'PY'\nimport json\nr=json.load(open('/work/results.json'));print(json.dumps({'hits':len(r['results']),'errors':r['errors'],'fixed':sum(x['path'].endswith('/fixed.py') for x in r['results'])}))\nPY`;
    const result = await sandbox.exec(command, 60);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ hits: 5, errors: [], fixed: 0 });
  } finally { await sandbox.stop(); await sandbox.assertNoRunContainers(); await rm(target, { recursive: true, force: true }); }
}, 150_000);
