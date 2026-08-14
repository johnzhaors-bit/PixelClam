import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditComponentsFast, estimateTextTokens, packStandardsByBudget } from '../src/main/fast-component-audit.mjs';

test('按总上下文预算动态装包且不拆开单个规范', () => {
  const standards = [
    { componentFamily: 'a', estimatedTokens: 3000 },
    { componentFamily: 'b', estimatedTokens: 4000 },
    { componentFamily: 'c', estimatedTokens: 5000 }
  ];
  const packed = packStandardsByBudget({
    standards,
    fixedPrefixTokens: 6000,
    budget: { contextWindowTokens: 20000, reservedOutputTokens: 2000, safetyRatio: 0.1 }
  });
  assert.deepEqual(packed.batches.map((batch) => batch.map((item) => item.componentFamily)), [['a', 'b'], ['c']]);
  assert.equal(packed.standardBudget, 10000);
  assert.ok(estimateTextTokens('<main>中文</main>') > 0);
});

test('快速模式发送完整 DOM 和多份自包含规范并核对收件确认', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixelclam-fast-'));
  const evidencePath = path.join(dir, 'dom.html');
  await fs.writeFile(evidencePath, '<main><button id="save">保存</button><input id="name"></main>');
  const standards = [];
  for (const family of ['button', 'input']) {
    const standardPath = path.join(dir, `${family}.json`);
    await fs.writeFile(standardPath, JSON.stringify({ selfContained: true, component: { id: family }, marker: `${family.toUpperCase()}_FULL_STANDARD` }));
    standards.push({ componentFamily: family, standardPath });
  }
  const requests = [];
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    const content = JSON.parse(request.messages.at(-1).content);
    const components = content.batch.components;
    return new Response(JSON.stringify({
      model: 'mock-kimi',
      usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, cached_tokens: requests.length > 1 ? 600 : 0 },
      choices: [{ message: { content: JSON.stringify({
        batch: { index: 1, total: 1, domReceived: true, receivedStandardCount: components.length, receivedComponents: components, lastReceivedComponent: components.at(-1) },
        componentResults: components.map((family) => ({
          componentFamily: family,
          results: family === 'button' ? [{ componentName: '保存', matchedVariant: 'primary', confidence: 0.95, issues: [{ location: '主区，代码位置（#save）', problem: '当前高度40px，应该32px', severity: 'high' }] }] : [],
          summary: ''
        })),
        summary: '完成'
      }) } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const output = await auditComponentsFast({
    mode: 'dom', evidencePath, standards, artifactDir: dir, fetchImpl,
    config: { enabled: true, provider: 'openai-compatible', baseUrl: 'https://example.invalid/v1', model: 'mock-kimi', apiKey: 'test', fastMode: { contextWindowTokens: 50000, reservedOutputTokens: 3000 } }
  });
  assert.equal(requests.length, 1);
  const sent = requests[0].messages.at(-1).content;
  assert.match(sent, /<button id=\\?"save/);
  assert.match(sent, /BUTTON_FULL_STANDARD/);
  assert.match(sent, /INPUT_FULL_STANDARD/);
  assert.equal(output.componentRuns.length, 2);
  assert.equal(output.componentRuns[0].result.results[0].issues.length, 1);
  assert.equal(output.componentRuns.filter((run) => run.usage).length, 1);
});
