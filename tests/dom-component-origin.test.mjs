import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyDomComponentOrigins } from '../src/main/dom-component-origin.mjs';

const config = { enabled: true, provider: 'openai-compatible', baseUrl: 'https://example.invalid/v1', model: 'mock', apiKey: 'test', timeoutMs: 5000 };

test('盘点只发送组件识别信息，不发送样式规则，也不判断组件库来源', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxchecker2-inventory-'));
  const evidencePath = path.join(dir, 'dom.html');
  const standardPath = path.join(dir, 'button.json');
  await fs.writeFile(evidencePath, '<button class="project-button">保存</button>');
  await fs.writeFile(standardPath, JSON.stringify({ component: { displayName: '按钮' }, detection: { selectorAliases: ['project-button'] }, rules: { secret: 'STYLE_MUST_NOT_BE_SENT' } }));
  let requestBody;
  const fetchImpl = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ components: [{ componentFamily: 'button', status: 'present', confidence: 0.99, evidence: ['button.project-button'] }], summary: '出现按钮' }) } }] }), { status: 200 });
  };
  const result = await classifyDomComponentOrigins({ evidencePath, standards: [{ componentFamily: 'button', standardPath }], config, fetchImpl, artifactDir: dir });
  assert.deepEqual(result.auditFamilies, ['button']);
  assert.doesNotMatch(requestBody.messages[1].content, /STYLE_MUST_NOT_BE_SENT/);
  assert.match(requestBody.messages[0].content, /不判断组件库来源/);
  await fs.access(path.join(dir, 'dom-component-inventory.json'));
});

test('页面没有候选节点时直接跳过该组件族', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxchecker2-inventory-absent-'));
  const evidencePath = path.join(dir, 'dom.html');
  const standardPath = path.join(dir, 'upload.json');
  await fs.writeFile(evidencePath, '<main><p>空页面</p></main>');
  await fs.writeFile(standardPath, JSON.stringify({ component: { displayName: '上传' }, detection: { selectorAliases: ['my-upload'] } }));
  let called = false;
  const result = await classifyDomComponentOrigins({ evidencePath, standards: [{ componentFamily: 'upload', standardPath }], config, fetchImpl: async () => { called = true; throw new Error('不应调用'); } });
  assert.equal(called, false);
  assert.deepEqual(result.skippedAbsentFamilies, ['upload']);
  assert.deepEqual(result.auditFamilies, []);
});
