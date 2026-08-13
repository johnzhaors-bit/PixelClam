import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditComponent } from '../src/main/component-audit.mjs';

test('sends exactly one component standard and writes auditable artifacts', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxchecker2-model-'));
  const evidencePath = path.join(outDir, 'dom-evidence.html');
  const standardPath = path.join(outDir, 'button.json');
  await fs.writeFile(evidencePath, '<button style="border-radius:2px">导出</button>', 'utf8');
  await fs.writeFile(standardPath, JSON.stringify({
    selfContained: true,
    component: 'button',
    radius: '3px',
    marker: 'BUTTON_ONLY',
    provenance: { traceOnlyMissingPath: '/definitely/not/available/to/non-ide-model.less' }
  }), 'utf8');
  let requestBody;
  const fetchImpl = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      model: 'mock-kimi',
      choices: [{ message: { content: JSON.stringify({
        componentFamily: 'button',
        results: [{
          componentName: '导出',
          matchedVariant: 'default',
          confidence: 0.9,
          issues: [{
            location: '工具栏，代码位置（button）',
            problem: '当前圆角2px，应该3px',
            severity: 'medium'
          }]
        }],
        summary: '发现一处问题'
      }) } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const output = await auditComponent({
    mode: 'dom',
    evidencePath,
    standardPath,
    componentFamily: 'button',
    artifactDir: outDir,
    fetchImpl,
    config: {
      enabled: true,
      provider: 'openai-compatible',
      baseUrl: 'https://example.invalid/v1',
      model: 'mock-kimi',
      apiKey: 'test-key',
      temperature: 0,
      timeoutMs: 5000
    }
  });

  const sent = requestBody.messages[1].content;
  assert.match(sent, /border-radius:2px/);
  assert.match(sent, /BUTTON_ONLY/);
  assert.doesNotMatch(sent, /INPUT_ONLY|TABLE_ONLY/);
  assert.equal(output.result.results[0].issues[0].severity, 'medium');
  const manifest = JSON.parse(await fs.readFile(output.requestManifestPath, 'utf8'));
  assert.equal(manifest.componentFamily, 'button');
  assert.equal(manifest.standardPath, standardPath);
  assert.equal(manifest.evidenceSha256.length, 64);
  assert.equal(manifest.standardSha256.length, 64);
  const raw = JSON.parse(await fs.readFile(output.rawResponsePath, 'utf8'));
  assert.match(raw.content, /发现一处问题/);
});

test('keeps focused DOM evidence and current standard in the same user message', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxchecker2-prefix-'));
  const evidencePath = path.join(outDir, 'dom-evidence.html');
  await fs.writeFile(evidencePath, '<main><button>保存</button><input value="名称"></main>', 'utf8');
  const requestBodies = [];
  const fetchImpl = async (_url, init) => {
    requestBodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      model: 'kimi-k3',
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cached_tokens: requestBodies.length > 1 ? 70 : 0 },
      choices: [{ message: { content: JSON.stringify({ results: [], summary: '完成' }) } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const config = { enabled: true, provider: 'openai-compatible', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k3', apiKey: 'test-key', timeoutMs: 5000 };
  for (const family of ['button', 'input']) {
    const standardPath = path.join(outDir, `${family}.json`);
    await fs.writeFile(standardPath, JSON.stringify({ component: family, marker: `${family.toUpperCase()}_ONLY` }));
    const output = await auditComponent({ mode: 'dom', evidencePath, standardPath, componentFamily: family, fetchImpl, config });
    assert.equal(output.usage.prompt_tokens, 100);
  }
  assert.equal(requestBodies.length, 2);
  assert.equal(requestBodies[0].reasoning_effort, 'low');
  assert.match(requestBodies[0].messages[1].content, /<button>保存<\/button>/);
  assert.match(requestBodies[0].messages[1].content, /BUTTON_ONLY/);
  assert.match(requestBodies[1].messages[1].content, /<input value=\\"名称\\">/);
  assert.match(requestBodies[1].messages[1].content, /INPUT_ONLY/);
});
