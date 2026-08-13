#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const runDir = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('用法：node scripts/verify-app-acceptance-run.mjs <App生成的run目录>');

const readJson = async (name) => JSON.parse(await fs.readFile(path.join(runDir, name), 'utf8'));
const expected = JSON.parse(await fs.readFile(new URL('../tests/fixtures/controlled-multi-component-errors.expected.json', import.meta.url), 'utf8'));
const plan = await readJson('audit-plan.json');
const report = await readJson('report.json');
const failures = [];
const checks = [];
const check = (id, passed, detail) => {
  checks.push({ id, passed, detail });
  if (!passed) failures.push({ id, detail });
};

const componentSteps = plan.steps.filter((item) => item.auditFamily === 'component' || item.componentFamily);
check('PLAN-64', componentSteps.length === 64, `组件计划 ${componentSteps.length}/64`);
check('PLAN-TERMINAL', componentSteps.every((item) => !['pending', 'running', 'failed'].includes(item.status)), '所有组件计划均应完成、免检或未出现');
check('REPORT-SKIN', report.skin === 'default', `实际皮肤 ${report.skin}`);
check('REPORT-FAMILIES', ['button', 'input', 'select'].every((id) => report.components.some((item) => item.componentFamily === id)), '应包含 button/input/select 三轮');
check('REPORT-ABSENT', report.summary.skippedAbsentFamilyCount === 61, `页面未出现 ${report.summary.skippedAbsentFamilyCount} 个`);
check('REPORT-LAYOUT', Boolean(report.layout) && report.layout.issues?.length > 0, '应生成布局结果并命中左对齐问题');
check('REPORT-USAGE', Number(report.summary.usage?.totalTokens) > 0, `总tokens ${report.summary.usage?.totalTokens || 0}`);

for (const [family, cases] of Object.entries(expected.expectedByRound)) {
  const issues = family === 'layout'
    ? report.layout?.issues || []
    : report.components.find((item) => item.componentFamily === family)?.results?.flatMap((item) => item.issues || []) || [];
  const searchable = issues.map((issue) => `${issue.location || ''} ${issue.problem || ''}`.toLowerCase());
  for (const item of cases) {
    const target = String(item.target).replace(/^#/, '').toLowerCase();
    const actual = String(item.actual).match(/\d+(?:\.\d+)?/)?.[0] || '';
    const wanted = String(item.expected).match(/\d+(?:\.\d+)?/)?.[0] || '';
    const passed = searchable.some((text) => text.includes(target)
      && (!actual || new RegExp(`(^|\\D)${actual}(?:px)?(\\D|$)`).test(text))
      && (!wanted || new RegExp(`(^|\\D)${wanted}(?:px)?(\\D|$)`).test(text)));
    check(item.id, passed, passed ? '命中' : `未在 ${family} 结果中命中`);
  }
}

const output = { runDir, passed: failures.length === 0, checks, failures };
await fs.writeFile(path.join(runDir, 'acceptance-verification.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ passed: output.passed, checkCount: checks.length, failureCount: failures.length, outputPath: path.join(runDir, 'acceptance-verification.json') })}\n`);
if (!output.passed) process.exitCode = 1;
