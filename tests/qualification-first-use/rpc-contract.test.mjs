import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { answerDialog, LIVE_SELECTION } from './rpc.mjs';
import { assertPrivateRoot, privateBase } from './private-root.mjs';

test('real host informational model title is approved while unknown/security prompts stay cancelled', () => {
  const confirmation = title => answerDialog({ id: 'host-rpc', method: 'confirm', title });
  assert.equal(confirmation('Use this Pi assessment model?').confirmed, true);
  assert.equal(confirmation('Use this assessment model and bounded planning spend?').confirmed, true);
  assert.equal(confirmation('Change account credentials?').cancelled, true);
  const model = answerDialog({ id: 'model', method: 'select', title: 'Assessment model (parent agent selection is NOT consent)', options: ['deepseek/deepseek-flash', 'unapproved/model'] }, { live: LIVE_SELECTION });
  assert.equal(model.value, 'deepseek/deepseek-flash');
  assert.equal(answerDialog({ id: 'budget', method: 'input', title: 'Unknown financial approval' }).cancelled, true);
});

test('qualification roots reject unsafe ancestors and symlink roots before owner data is written', () => {
  const root = mkdtempSync('/tmp/p2o-root-contract-');
  chmodSync(root, 0o700);
  try {
    assert.equal(assertPrivateRoot(root), root);
    const shared = join(root, 'shared'); mkdirSync(shared); chmodSync(shared, 0o777);
    const child = join(shared, 'private'); mkdirSync(child, { mode: 0o700 });
    assert.throws(() => assertPrivateRoot(child), /UNSAFE_PRIVATE_ROOT/);
    assert.equal(privateBase([child, root]), root);
    const alias = join(root, 'alias'); symlinkSync(root, alias);
    assert.throws(() => assertPrivateRoot(alias), /UNSAFE_PRIVATE_ROOT/);
    assert.throws(() => assertPrivateRoot(join(alias, 'shared')), /UNSAFE_PRIVATE_ROOT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
