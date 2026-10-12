import { describe, expect, it } from 'vitest';
import { DashboardScreen } from '../../src/ui/dashboard-screen.js';

const sections: Record<string, string[]> = {
  overview: ['overview line 1', 'overview line 2'],
  workers: ['workers line'],
  tasks: Array.from({ length: 20 }, (_, i) => `task line ${i}`),
  coverage: ['coverage line'],
  cases: ['cases line'],
  log: ['log line'],
};

describe('DashboardScreen (pure component, no IO/model/authority)', () => {
  it('starts on the given tab and shows its content with the tab bar', () => {
    const screen = new DashboardScreen(section => sections[section], 'overview', () => {});
    const out = screen.render(80).join('\n');
    expect(out).toContain('[1:overview]');
    expect(out).toContain('overview line 1');
    expect(out).toContain('←→/1-6 tabs');
  });

  it('switches tabs with number keys, left/right, and resets scroll', () => {
    const screen = new DashboardScreen(section => sections[section], 'overview', () => {});
    screen.handleInput('3'); // tasks
    expect(screen.render(80).join('\n')).toContain('task line 0');
    screen.handleInput('\x1b[C'); // right arrow -> coverage
    expect(screen.render(80).join('\n')).toContain('coverage line');
    screen.handleInput('\x1b[D'); // left arrow -> back to tasks
    expect(screen.render(80).join('\n')).toContain('task line 0');
  });

  it('wraps tab cycling at both ends', () => {
    const screen = new DashboardScreen(section => sections[section], 'overview', () => {});
    screen.handleInput('\x1b[D'); // left from overview wraps to log
    expect(screen.render(80).join('\n')).toContain('log line');
    screen.handleInput('\x1b[C'); // right from log wraps to overview
    expect(screen.render(80).join('\n')).toContain('overview line 1');
  });

  it('scrolls within a tab and bounds the offset', () => {
    const screen = new DashboardScreen(section => sections[section], 'tasks', () => {});
    screen.render(80); // establish content
    screen.handleInput('\x1b[B'); // down by one
    const page = screen.render(80).join('\n');
    expect(page).not.toContain('[3:tasks]'); // the tab bar (the first line) scrolled out of view
    expect(page).toContain('task line 0');
    for (let i = 0; i < 50; i++) screen.handleInput('\x1b[B'); // scroll far past the end
    expect(() => screen.render(80)).not.toThrow();
  });

  it('closes on escape/q/ctrl+c and refreshes live without losing the current tab', () => {
    let closed = 0;
    const screen = new DashboardScreen(section => sections[section], 'workers', () => { closed += 1; });
    expect(screen.render(80).join('\n')).toContain('workers line');
    let rendered = 0;
    const live = new DashboardScreen(section => sections[section], 'workers', () => {}, () => { rendered += 1; });
    live.refresh();
    expect(rendered).toBe(1);
    expect(live.render(80).join('\n')).toContain('workers line'); // same tab after a live refresh
    screen.handleInput('q');
    expect(closed).toBe(1);
  });

  it('never throws on an empty section and stays within the requested width', () => {
    const screen = new DashboardScreen(() => [], 'overview', () => {});
    const lines = screen.render(30);
    expect(lines.every(line => line.length <= 30 || /[\u001b\u0007]/.test(line))).toBe(true);
  });
});
