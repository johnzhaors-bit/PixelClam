#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const [expectedArg, runDirArg] = process.argv.slice(2);
if (!expectedArg || !runDirArg) {
  throw new Error('用法：node scripts/evaluate-controlled-audit.mjs <expected.json> <run-dir>');
}

const expectedPath = path.resolve(expectedArg);
const runDir = path.resolve(runDirArg);
const expected = JSON.parse(await fs.readFile(expectedPath, 'utf8'));
const rounds = expected.expectedByRound || { [expected.componentFamily]: expected.expectedIssues || [] };
const evaluation = {
  schemaVersion: 'controlled-audit-evaluation-v1',
  fixture: expected.fixture,
  skin: expected.skin,
  runDir,
  rounds: {},
  summary: { expected: 0, hit: 0, missed: 0, modelIssueObjects: 0 }
};

for (const [round, cases] of Object.entries(rounds)) {
  const resultPath = path.join(runDir, `${round}-result.json`);
  const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
  const issues = round === 'layout'
    ? result.issues || []
    : (result.results || []).flatMap((item) => item.issues || []);
  const searchable = issues.map((issue) => `${issue.location || ''} ${issue.problem || ''}`.toLowerCase());
  const checks = cases.map((item) => {
    const targetToken = String(item.target || '').replace(/^#/, '').toLowerCase();
    const actualNumber = String(item.actual || '').match(/\d+(?:\.\d+)?/)?.[0] || '';
    const expectedNumber = String(item.expected || '').match(/\d+(?:\.\d+)?/)?.[0] || '';
    const mustContain = (Array.isArray(item.mustContain) ? item.mustContain : [])
      .map((token) => String(token).toLowerCase());
    const hitIndex = searchable.findIndex((text) =>
      (!targetToken || text.includes(targetToken)) &&
      (!actualNumber || new RegExp(`(^|\\D)${actualNumber}(?:px)?(\\D|$)`, 'i').test(text)) &&
      (!expectedNumber || new RegExp(`(^|\\D)${expectedNumber}(?:px)?(\\D|$)`, 'i').test(text)) &&
      mustContain.every((token) => text.includes(token))
    );
    return { ...item, hit: hitIndex >= 0, matchedIssue: hitIndex >= 0 ? issues[hitIndex] : null };
  });
  const hit = checks.filter((item) => item.hit).length;
  evaluation.rounds[round] = {
    resultPath,
    expected: checks.length,
    hit,
    missed: checks.length - hit,
    modelIssueObjects: issues.length,
    checks
  };
  evaluation.summary.expected += checks.length;
  evaluation.summary.hit += hit;
  evaluation.summary.missed += checks.length - hit;
  evaluation.summary.modelIssueObjects += issues.length;
}

evaluation.summary.recall = evaluation.summary.expected
  ? Number((evaluation.summary.hit / evaluation.summary.expected).toFixed(4))
  : 1;
evaluation.summary.passed = evaluation.summary.missed === 0;
const outputPath = path.join(runDir, 'controlled-evaluation.json');
await fs.writeFile(outputPath, JSON.stringify(evaluation, null, 2));
process.stdout.write(`${JSON.stringify({ outputPath, ...evaluation.summary })}\n`);
if (!evaluation.summary.passed) process.exitCode = 1;
