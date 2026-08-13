import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectDomSnapshot } from '../src/main/dom-snapshot.mjs';

test('freezes a self-contained visible DOM evidence file without component extraction', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxchecker2-snapshot-'));
  const fixture = path.resolve('tests/fixtures/component-page.html');
  const snapshot = await collectDomSnapshot({ url: pathToFileURL(fixture).href, outDir });
  const fullHtml = await fs.readFile(snapshot.snapshotPath, 'utf8');
  const modelHtml = await fs.readFile(snapshot.modelSnapshotPath, 'utf8');
  const manifest = JSON.parse(await fs.readFile(path.join(outDir, 'snapshot-manifest.json'), 'utf8'));

  assert.match(fullHtml, /新建资源/);
  assert.match(fullHtml, /data-ux-box=/);
  assert.match(fullHtml, /value="测试数据"/);
  assert.doesNotMatch(modelHtml, /hidden-login/);
  assert.match(modelHtml, /新建资源/);
  assert.equal(manifest.freezeSummary.authenticationRequiredAfterFreeze, false);
  assert.ok(manifest.freezeSummary.modelSnapshotBytes < manifest.freezeSummary.snapshotBytes);
});
