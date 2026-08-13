import test from 'node:test';
import assert from 'node:assert/strict';
import scoring from '../electron/scoring.cjs';

const { scoreIssues } = scoring;

function issues(severity, count) {
  return Array.from({ length: count }, () => ({ severity }));
}

test('无问题为 100 分', () => {
  assert.deepEqual(scoreIssues([]).score, 100);
});

test('同级问题采用边际递减，19 条中等问题不再归零', () => {
  const result = scoreIssues(issues('medium', 19));
  assert.equal(result.score, 64);
  assert.equal(result.counts.medium, 19);
});

test('大量严重问题仍会形成低分，但普通规范问题最低为 15 分', () => {
  assert.equal(scoreIssues(issues('severe', 30)).score, 15);
});

test('兼容模型的 high/medium/low 严重度名称', () => {
  const result = scoreIssues([{ severity: 'high' }, { severity: 'medium' }, { severity: 'low' }]);
  assert.deepEqual(result.counts, { severe: 1, medium: 1, minor: 1 });
  assert.equal(result.score, 89);
});
