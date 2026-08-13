import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeLayoutResult } from '../src/main/layout-audit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const packPath = path.resolve(here, '../user-data/skills/示例规范/standards/layout/layout-audit-pack-v1.json');

test('layout pack is standalone and contains atomic conditional rules', async () => {
  const pack = JSON.parse(await fs.readFile(packPath, 'utf8'));
  assert.equal(pack.skinIndependent, true);
  assert.ok(pack.atomicRules.length >= 5);
  assert.ok(pack.atomicRules.every((rule) => rule.id && rule.appliesWhen && rule.check && rule.expected));
  assert.ok(pack.atomicRules.some((rule) => rule.id === 'LAYOUT.ALIGN.001'));
  assert.equal(pack.outputPolicy.onlyReportApplicableRules, true);
});

test('normalizer drops malformed and non-layout issues', () => {
  const result = normalizeLayoutResult({
    pagePattern: 'table-page',
    confidence: 2,
    issues: [
      { ruleId: 'LAYOUT.ALIGN.001', location: '表格区', problem: '当前错位，应该对齐', severity: 'high', confidence: 0.9 },
      { ruleId: 'BUTTON.001', location: '按钮', problem: '颜色错误', severity: 'high', confidence: 1 },
      { ruleId: 'LAYOUT.SPACE.001', location: '', problem: '无位置' }
    ]
  }, 'dom');
  assert.equal(result.confidence, 1);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].ruleId, 'LAYOUT.ALIGN.001');
});
