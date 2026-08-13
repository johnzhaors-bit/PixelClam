'use strict';

function normalizeSeverity(value) {
  if (value === 'severe' || value === 'high') return 'severe';
  if (value === 'medium') return 'medium';
  return 'minor';
}

function tierPenalty(count, firstCount, firstWeight, laterWeight) {
  const total = Math.max(0, Number(count) || 0);
  return Math.min(total, firstCount) * firstWeight
    + Math.max(0, total - firstCount) * laterWeight;
}

/**
 * 问题越多时，后续同级问题采用较低边际扣分，避免大型页面因为重复样式问题直接归零。
 * 0 分只应留给页面完全不可用等阻断性结论；普通规范问题最低保留 15 分。
 */
function scoreIssues(issues = []) {
  const counts = { severe: 0, medium: 0, minor: 0 };
  for (const issue of issues) counts[normalizeSeverity(issue?.severity)] += 1;

  const bySeverity = {
    severe: tierPenalty(counts.severe, 3, 7, 3),
    medium: tierPenalty(counts.medium, 5, 3, 1.5),
    minor: tierPenalty(counts.minor, 8, 1, 0.5)
  };
  const rawPenalty = bySeverity.severe + bySeverity.medium + bySeverity.minor;
  const penalty = Math.min(85, Math.round(rawPenalty));
  return {
    score: Math.max(15, 100 - penalty),
    penalty,
    rawPenalty,
    counts,
    bySeverity
  };
}

module.exports = { scoreIssues };
