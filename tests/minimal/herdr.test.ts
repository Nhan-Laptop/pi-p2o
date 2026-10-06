import { describe, expect, it } from 'vitest';
import { chooseSplit, createHerdrClient, workerName, type PaneRect } from '../../src/herdr.js';
import type { RunProcess } from '../../src/process.js';

const pane = (paneId: string, x: number, y: number, width: number, height: number): PaneRect => ({ paneId, x, y, width, height });

function driver() {
  const calls: string[][] = [];
  let layout: PaneRect[] = [pane('w1T:p1', 0, 0, 100, 40)];
  let failNext: string | undefined;
  const run: RunProcess = async args => {
    calls.push(args);
    if (failNext && args.join(' ').includes(failNext)) { failNext = undefined; return { code: 1, stdout: '', stderr: 'boom', truncated: false }; }
    if (args[0] === 'status') return { code: 0, stdout: 'status: running\n', stderr: '', truncated: false };
    if (args[0] === 'pane' && args[1] === 'layout') return { code: 0, stdout: JSON.stringify({ result: { layout: { panes: layout.map(entry => ({ pane_id: entry.paneId, rect: { x: entry.x, y: entry.y, width: entry.width, height: entry.height } })) } } }), stderr: '', truncated: false };
    if (args[0] === 'pane' && args[1] === 'split') return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: 'w1T:p9' } } }), stderr: '', truncated: false };
    if (args[0] === 'agent' && args[1] === 'get') return { code: 0, stdout: JSON.stringify({ result: { agent: { name: args[2], pane_id: 'w1T:p9', agent_status: 'working' } } }), stderr: '', truncated: false };
    if (args[0] === 'agent' && args[1] === 'list') return { code: 0, stdout: JSON.stringify({ result: { agents: [{ pane_id: 'w1T:p9', agent_status: 'idle' }] } }), stderr: '', truncated: false };
    return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: '', truncated: false };
  };
  return { calls, run, setLayout: (value: PaneRect[]) => { layout = value; }, failNext: (value: string) => { failNext = value; } };
}

describe('herdr client', () => {
  it('tiles panes with the pi-herdr rule instead of shaving one column', () => {
    expect(chooseSplit([pane('a', 0, 0, 100, 40)])).toEqual({ paneId: 'a', direction: 'right' });
    expect(chooseSplit([pane('a', 0, 0, 40, 40)])).toEqual({ paneId: 'a', direction: 'down' });
    // Splitting the widest pane keeps cells usable; the small pane is not chosen.
    expect(chooseSplit([pane('small', 0, 0, 20, 8), pane('big', 20, 0, 80, 40)])?.paneId).toBe('big');
    // A saturated tab still returns a pane so Herdr can place the child.
    expect(chooseSplit([pane('tiny', 0, 0, 10, 4)])?.paneId).toBe('tiny');
    expect(chooseSplit([])).toBeUndefined();
  });

  it('splits, starts a real pi pane with our worker flag, prompts, and reads status', async () => {
    const d = driver();
    const client = createHerdrClient(d.run, { HERDR_ENV: '1' });
    expect(await client.available()).toBe(true);
    const paneId = await client.split({ cwd: '/tmp/work' });
    expect(paneId).toBe('w1T:p9');
    const split = d.calls.find(args => args[1] === 'split')!;
    expect(split).toContain('--no-focus');
    expect(split[split.indexOf('--direction') + 1]).toBe('right');
    expect(split[split.indexOf('--cwd') + 1]).toBe('/tmp/work');
    await client.start({ name: 'p2o-recon-aaaaaa', paneId, args: ['--model', 'x/y', '--p2o-worker', '/control/ticket.json'] });
    const start = d.calls.find(args => args[1] === 'start')!;
    expect(start.slice(0, 6)).toEqual(['agent', 'start', 'p2o-recon-aaaaaa', '--kind', 'pi', '--pane']);
    expect(start).toContain('--p2o-worker');
    await client.prompt({ name: 'p2o-recon-aaaaaa', text: 'brief' });
    const prompt = d.calls.find(args => args[1] === 'prompt')!;
    expect(prompt).toEqual(['agent', 'prompt', 'p2o-recon-aaaaaa', 'brief']);
    expect(prompt).not.toContain('--wait'); // a long worker turn must not block the owner
    expect((await client.get('p2o-recon-aaaaaa')).status).toBe('working');
    expect((await client.statuses(['p2o-recon-aaaaaa', 'missing'])).get('p2o-recon-aaaaaa')).toBe('working');
    d.failNext('agent get');
    expect((await client.statuses(['missing'])).get('missing')).toBe('unknown');
    await client.interrupt('p2o-recon-aaaaaa');
    await client.closePane(paneId);
    expect(d.calls.some(args => args[1] === 'send-keys')).toBe(true);
    expect(d.calls.some(args => args[1] === 'close')).toBe(true);
  });

  it('confirms a close by listing panes and never treats a failed lookup as closed', async () => {
    const calls: string[][] = [];
    let panes = ['w1T:p9'];
    let listingFails = false;
    const run: RunProcess = async args => {
      calls.push(args);
      if (args[1] === 'list') {
        if (listingFails) return { code: 1, stdout: '', stderr: 'boom', truncated: false };
        return { code: 0, stdout: JSON.stringify({ result: { panes: panes.map(pane_id => ({ pane_id })) } }), stderr: '', truncated: false };
      }
      if (args[1] === 'close') { panes = panes.filter(pane => pane !== args[2]); return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: '', truncated: false }; }
      return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: '', truncated: false };
    };
    const client = createHerdrClient(run, { HERDR_ENV: '1' });
    expect(await client.closePane('w1T:p9')).toBe(true);
    // A pane the daemon refuses to close is reported as not closed.
    panes = ['w1T:p9'];
    const stubborn: RunProcess = async args => args[1] === 'list'
      ? { code: 0, stdout: JSON.stringify({ result: { panes: [{ pane_id: 'w1T:p9' }] } }), stderr: '', truncated: false }
      : { code: 0, stdout: JSON.stringify({ result: {} }), stderr: '', truncated: false };
    expect(await createHerdrClient(stubborn, { HERDR_ENV: '1' }).closePane('w1T:p9')).toBe(false);
    listingFails = true;
    expect(await client.closePane('w1T:p9')).toBe(false);
  });

  it('reports unavailability without Herdr and survives a failed split by falling back', async () => {
    const d = driver();
    expect(await createHerdrClient(d.run, {}).available()).toBe(false);
    expect(await createHerdrClient(async () => { throw new Error('ENOENT'); }, { HERDR_ENV: '1' }).available()).toBe(false);
    const client = createHerdrClient(d.run, { HERDR_ENV: '1' });
    d.failNext('layout');
    expect(await client.split({ cwd: '/tmp' })).toBe('w1T:p9');
    const split = d.calls.filter(args => args[1] === 'split').at(-1)!;
    expect(split).toContain('--current');
    d.failNext('agent start');
    await expect(client.start({ name: 'x', paneId: 'p', args: [] })).rejects.toThrow(/herdr agent start failed/);
  });

  it('mints bounded p2o worker names', () => {
    const name = workerName('validation');
    expect(name).toMatch(/^p2o-validation-[0-9a-f]{6}$/);
    expect(workerName('Recon Unit')).toMatch(/^p2o-reconunit-[0-9a-f]{6}$/);
    expect(name.length).toBeLessThanOrEqual(32);
  });
});
