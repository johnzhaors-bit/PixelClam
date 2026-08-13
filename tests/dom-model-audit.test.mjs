import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDomAuditResult } from '../src/main/dom-model-audit.mjs';
import { mergeComponentResults } from '../src/main/component-audit.mjs';

test('normalizes concise model output and caps issues per component', () => {
  const result = normalizeDomAuditResult({
    results: [{
      componentName: '导出按钮',
      matchedVariant: 'default',
      confidence: 2,
      issues: [
        { location: '工具栏，代码位置（.toolbar button）', problem: '当前圆角2px，应该3px', severity: 'medium' },
        { location: '工具栏，代码位置（.toolbar）', problem: '当前间距16px，应该8px', severity: 'high' },
        { location: 'ignored', problem: 'ignored', severity: 'high' }
      ]
    }]
  }, 'button');
  assert.equal(result.componentFamily, 'button');
  assert.equal(result.results[0].confidence, 1);
  assert.equal(result.results[0].issues.length, 2);
});

test('merges component runs without changing model findings', () => {
  const report = mergeComponentResults({
    mode: 'image',
    skin: 'ai-dark',
    source: { imagePath: '/tmp/page.png' },
    originRun: { model: 'kimi', usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
    layoutRun: { result: { issues: [] }, usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 } },
    componentRuns: [{
      componentFamily: 'button',
      standardPath: '/standards/ai-dark/components/button.json',
      model: 'kimi',
      usage: { prompt_tokens: 300, completion_tokens: 30, total_tokens: 330 },
      result: {
        mode: 'image',
        results: [{ componentName: '保存', issues: [{ severity: 'high' }, { severity: 'low' }] }],
        summary: '存在问题'
      }
    }]
  });
  assert.equal(report.skin, 'ai-dark');
  assert.equal(report.summary.issueCount, 2);
  assert.deepEqual(report.summary.severityCounts, { high: 1, medium: 0, low: 1 });
  assert.equal(report.components[0].results[0].componentName, '保存');
  assert.deepEqual(report.summary.usage, { promptTokens: 600, cachedTokens: 0, completionTokens: 60, totalTokens: 660 });
});
