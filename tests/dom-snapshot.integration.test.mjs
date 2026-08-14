import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectDomSnapshot } from '../src/main/dom-snapshot.mjs';
import { extractHtmlFromMhtml } from '../src/main/electron-dom-snapshot.mjs';

test('extracts and decodes only the HTML part of a saved MHTML page', () => {
  const largeImage = Buffer.alloc(33 * 1024, 1).toString('base64');
  const mhtml = [
    'Content-Type: multipart/related; boundary="demo-boundary"',
    '',
    '--demo-boundary',
    'Content-Type: text/html',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '<html><body><button style=3D"color:#1993ff">=E6=9F=A5=E8=AF=A2</button><img src=3D"https://demo/icon-import.png"><img src=3D"https://demo/banner.png"><script>bad()</script></body></html>',
    '--demo-boundary',
    'Content-Type: image/png',
    'Content-Transfer-Encoding: base64',
    'Content-Location: https://demo/icon-import.png',
    '',
    Buffer.from('small-icon').toString('base64'),
    '--demo-boundary',
    'Content-Type: image/png',
    'Content-Transfer-Encoding: base64',
    'Content-Location: https://demo/banner.png',
    '',
    largeImage,
    '--demo-boundary--'
  ].join('\r\n');
  const html = extractHtmlFromMhtml(mhtml);
  assert.match(html, /查询/);
  assert.match(html, /style="color:#1993ff"/);
  assert.match(html, /data-ux-image-name="icon-import.png"/);
  assert.match(html, /data-ux-image-resource="retained"/);
  assert.match(html, /data-ux-image-name="banner.png"[^>]+data-ux-image-resource="omitted"/);
  assert.match(html, /src="data:image\/png;base64,/);
  assert.doesNotMatch(html, /bad\(\)|largeImage/);
});

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
