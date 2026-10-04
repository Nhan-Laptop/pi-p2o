import { describe, expect, test } from 'vitest';
import { MAX_BUDGET_USD, MAX_CONCURRENCY, parseP2OArgs, tokenize } from '../../src/interface/argv.js';
import { classifyTargetSyntax } from '../../src/interface/targets.js';

describe('shell-free tokenizer', () => {
  test('groups quotes and escapes without shell expansion', () => {
    expect(tokenize('--target "/tmp/a b" --purpose \'find ${x} bugs\' --depth=deep'))
      .toEqual(['--target', '/tmp/a b', '--purpose', 'find ${x} bugs', '--depth=deep']);
    expect(tokenize('a\\ b "c\\"d" \'e"f\'')).toEqual(['a b', 'c"d', 'e"f']);
    expect(tokenize('  spaced   out  ')).toEqual(['spaced', 'out']);
  });

  test('rejects malformed quoting, escapes and control characters', () => {
    expect(() => tokenize('--target "unterminated')).toThrow(/UNTERMINATED_QUOTE/);
    expect(() => tokenize("--target 'unterminated")).toThrow(/UNTERMINATED_QUOTE/);
    expect(() => tokenize('--target foo\\')).toThrow(/TRAILING_ESCAPE/);
    expect(() => tokenize('--purpose bad\u0000text')).toThrow(/control character/);
    expect(() => tokenize('--target foo\x1b[31m')).toThrow(/control character/);
    expect(() => tokenize('x'.repeat(16_385))).toThrow(/16KiB/);
  });
});

describe('p2o grammar', () => {
  test('bare invocation and help are help', () => {
    expect(parseP2OArgs('')).toEqual({ verb: 'help' });
    expect(parseP2OArgs('   ')).toEqual({ verb: 'help' });
    expect(parseP2OArgs('help')).toEqual({ verb: 'help' });
    expect(parseP2OArgs('--help')).toEqual({ verb: 'help' });
    expect(parseP2OArgs('status --help')).toEqual({ verb: 'help' });
    expect(() => parseP2OArgs('help extra')).toThrow(/UNEXPECTED_ARGUMENT/);
  });

  test('the target form accepts exactly the documented flags', () => {
    expect(parseP2OArgs('--target ./repo')).toEqual({ verb: 'start', target: './repo', depth: 'standard', planOnly: false });
    expect(parseP2OArgs('--target "https://github.com/o/r" --purpose "audit auth" --depth=deep --plan-only --budget 12.50 --concurrency 4')).toEqual({
      verb: 'start', target: 'https://github.com/o/r', purpose: 'audit auth', depth: 'deep', planOnly: true, budgetUsd: 12.5, concurrency: 4,
    });
    // Purpose text is literal data, never executed or expanded.
    expect(parseP2OArgs('--target ./r --purpose "bad; rm -rf / $(whoami) `id`"')).toMatchObject({ purpose: 'bad; rm -rf / $(whoami) `id`' });
  });

  test('the one-dialog flags are typed and bounded', () => {
    expect(parseP2OArgs('--target ./repo --profile wide')).toMatchObject({ profile: 'wide' });
    expect(parseP2OArgs('--target ./repo --profile ceiling --basis owner')).toMatchObject({ profile: 'ceiling', basis: 'owner' });
    expect(parseP2OArgs('--target ./repo --full-rights')).toMatchObject({ repositoryScripts: true, stateChanges: true, fullRights: true });
    expect(parseP2OArgs('--target ./repo --advanced')).toMatchObject({ advanced: true });
    // --full-rights is a convenience for the two separate rights, never a third kind of grant.
    const repoScriptsOnly = parseP2OArgs('--target ./repo --repo-scripts');
    expect(repoScriptsOnly).toMatchObject({ repositoryScripts: true });
    expect('stateChanges' in repoScriptsOnly).toBe(false);
    for (const args of ['--target ./repo --profile infinite', '--target ./repo --profile', '--target ./repo --basis owner --basis owner',
      '--target ./repo --basis yes', '--target ./repo --full-rights=true', '--target ./repo --advanced --advanced']) {
      expect(() => parseP2OArgs(args)).toThrow();
    }
    expect(() => parseP2OArgs('--target ./repo --full-rights')).not.toThrow();
  });

  test('unknown and duplicate flags are denied', () => {
    expect(() => parseP2OArgs('--target ./repo --scan')).toThrow(/UNKNOWN_FLAG/);
    expect(() => parseP2OArgs('--target ./repo --technique authz')).toThrow(/UNKNOWN_FLAG/);
    expect(() => parseP2OArgs('--target ./repo --target ./other')).toThrow(/DUPLICATE_FLAG/);
    expect(() => parseP2OArgs('--target ./repo --depth quick --depth deep')).toThrow(/DUPLICATE_FLAG/);
    expect(() => parseP2OArgs('--target ./repo --plan-only --plan-only')).toThrow(/DUPLICATE_FLAG/);
  });

  test('invalid budgets, concurrency and depth are denied', () => {
    for (const budget of ['0', '-1', 'abc', '1e3', '1.234', '.5', '100000.01']) {
      expect(() => parseP2OArgs(`--target ./r --budget ${budget}`)).toThrow(/INVALID_BUDGET/);
    }
    expect(() => parseP2OArgs(`--target ./r --budget ${MAX_BUDGET_USD + 1}`)).toThrow(/INVALID_BUDGET/);
    for (const value of ['0', '-2', '2.5', 'abc', String(MAX_CONCURRENCY + 1)]) {
      expect(() => parseP2OArgs(`--target ./r --concurrency ${value}`)).toThrow(/INVALID_CONCURRENCY/);
    }
    expect(() => parseP2OArgs('--target ./r --depth extreme')).toThrow(/INVALID_DEPTH/);
  });

  test('missing values, missing target and unexpected positionals are denied', () => {
    expect(() => parseP2OArgs('--target')).toThrow(/MISSING_VALUE/);
    expect(() => parseP2OArgs('--target ./r --depth')).toThrow(/MISSING_VALUE/);
    expect(() => parseP2OArgs('--target ./r --depth --plan-only')).toThrow(/MISSING_VALUE/);
    expect(() => parseP2OArgs('--target= ')).toThrow(/MISSING_VALUE/);
    expect(() => parseP2OArgs('--purpose hello')).toThrow(/MISSING_TARGET/);
    expect(() => parseP2OArgs('--target ""')).toThrow(/MISSING_TARGET/);
    expect(() => parseP2OArgs('--target ./r ./extra')).toThrow(/UNEXPECTED_ARGUMENT/);
    expect(() => parseP2OArgs('--target ./r --plan-only=yes')).toThrow(/UNEXPECTED_ARGUMENT/);
  });

  test('lifecycle verbs accept at most one runId and no flags', () => {
    expect(parseP2OArgs('status')).toEqual({ verb: 'status' });
    expect(parseP2OArgs('stop run-1')).toEqual({ verb: 'stop', runId: 'run-1' });
    expect(parseP2OArgs('resume build_2:latest')).toEqual({ verb: 'resume', runId: 'build_2:latest' });
    expect(parseP2OArgs('report run-1')).toEqual({ verb: 'report', runId: 'run-1' });
    expect(() => parseP2OArgs('status a b')).toThrow(/UNEXPECTED_ARGUMENT/);
    expect(() => parseP2OArgs('status --all')).toThrow(/UNKNOWN_FLAG/);
    expect(() => parseP2OArgs('status ../etc/passwd')).toThrow(/INVALID_RUN_ID/);
  });

  test('approve requires exactly one planId', () => {
    expect(parseP2OArgs('approve plan-1')).toEqual({ verb: 'approve', planId: 'plan-1' });
    expect(() => parseP2OArgs('approve')).toThrow(/MISSING_PLAN_ID/);
    expect(() => parseP2OArgs('approve a b')).toThrow(/UNEXPECTED_ARGUMENT/);
    expect(() => parseP2OArgs('approve --all')).toThrow(/MISSING_PLAN_ID/);
  });

  test('unknown verbs are denied instead of treated as targets', () => {
    expect(() => parseP2OArgs('frobnicate ./repo')).toThrow(/UNKNOWN_VERB/);
    expect(() => parseP2OArgs('./repo')).toThrow(/UNKNOWN_VERB/);
  });
});

describe('target classification', () => {
  test('the three accepted forms map to distinct kinds', () => {
    expect(classifyTargetSyntax('./repo')).toMatchObject({ kind: 'local-dir', raw: './repo' });
    expect(classifyTargetSyntax('https://github.com/owner/repo.git')).toMatchObject({ kind: 'github-repo', locator: 'https://github.com/owner/repo' });
    expect(classifyTargetSyntax('https://example.test/app?x=1')).toMatchObject({ kind: 'http-url', locator: 'https://example.test/app?x=1' });
  });

  test('bare hosts, credentials and non-http(s) schemes are refused without guessing a scheme', () => {
    for (const bad of ['example.com', '192.168.1.10', 'git://x/y', 'ssh://git@x/y', 'git@github.com:o/r.git', 'file:///tmp/x', 'postman://c/1', 'https://user:pw@example.test/']) {
      expect(() => classifyTargetSyntax(bad)).toThrow(/UNSUPPORTED_TARGET/);
    }
    expect(() => classifyTargetSyntax('')).toThrow(/MISSING_TARGET/);
  });
});
