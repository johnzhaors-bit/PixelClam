#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const componentsDir = path.join(root, 'user-data/skills/Paletx-MultiSkin-Audit/standards/component-packs-v3/skins/default/components');
const fixturesDir = path.join(root, 'tests/fixtures');
const files = (await fs.readdir(componentsDir)).filter((name) => name.endsWith('.json')).sort();
const expectedFiles = (await fs.readdir(fixturesDir)).filter((name) => name.endsWith('.expected.json'));
let verified = { components: {} };
try {
  verified = JSON.parse(await fs.readFile(path.join(root, 'tests/component-validation-results.json'), 'utf8'));
} catch {}
const coverage = new Map();
for (const file of expectedFiles) {
  const value = JSON.parse(await fs.readFile(path.join(fixturesDir, file), 'utf8'));
  const rounds = value.expectedByRound || { [value.componentFamily]: value.expectedIssues || [] };
  for (const [component, cases] of Object.entries(rounds)) {
    if (component === 'layout') continue;
    const current = coverage.get(component) || { fixtures: [], expectedErrorCount: 0, cleanControl: false };
    current.fixtures.push(value.fixture);
    current.expectedErrorCount += cases.length;
    current.cleanControl ||= Array.isArray(value.expectedCleanTargets) && value.expectedCleanTargets.length > 0;
    coverage.set(component, current);
  }
}
const matrix = {
  schemaVersion: 'component-validation-matrix-v1',
  generatedAt: new Date().toISOString(),
  acceptance: {
    requiredCases: ['错误实例', '正确对照实例', '状态或变体错误', '合法例外'],
    passCondition: '预设错误全部命中，正确实例和合法例外无误报，输出符合固定 JSON 模板'
  },
  summary: {
    componentCount: files.length,
    componentsWithControlledFixture: 0,
    baselineVerified: 0,
    fullyVerified: 0,
    componentsPending: 0
  },
  components: files.map((file) => {
    const id = path.basename(file, '.json');
    const item = coverage.get(id);
    return {
      id,
      standardPath: path.relative(root, path.join(componentsDir, file)),
      status: verified.components?.[id]?.baselineVerified ? 'baseline-verified' : item ? 'fixture-created' : 'pending',
      fixtures: item?.fixtures || [],
      expectedErrorCount: item?.expectedErrorCount || 0,
      requiredCoverage: {
        error: Boolean(item),
        cleanControl: Boolean(item?.cleanControl),
        stateOrVariant: false,
        legalException: false,
        kimiVerified: Boolean(verified.components?.[id]?.baselineVerified)
      },
      latestResult: verified.components?.[id] || null
    };
  })
};
matrix.summary.componentsWithControlledFixture = matrix.components.filter((item) => item.status !== 'pending').length;
matrix.summary.baselineVerified = matrix.components.filter((item) => item.requiredCoverage.kimiVerified).length;
matrix.summary.fullyVerified = matrix.components.filter((item) => Object.values(item.requiredCoverage).every(Boolean)).length;
matrix.summary.componentsPending = matrix.summary.componentCount - matrix.summary.componentsWithControlledFixture;
const outputPath = path.join(root, 'tests/component-validation-matrix.json');
await fs.writeFile(outputPath, JSON.stringify(matrix, null, 2));
process.stdout.write(`${JSON.stringify({ outputPath, ...matrix.summary })}\n`);
