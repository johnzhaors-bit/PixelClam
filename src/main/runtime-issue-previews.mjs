import fs from 'node:fs/promises';
import path from 'node:path';

function isGlobalIssue(issue) {
  const subject = String(issue?.subject || '');
  const location = String(issue?.location || '');
  return (
    subject.includes('页面全局') ||
    subject.includes('页面主体区域') ||
    location.includes('页面全局') ||
    location.includes('页面主体区域')
  );
}

function boxesToPreviewMarkers(boxes = []) {
  return boxes.map((box, markerIndex) => {
    const x = Number(box?.x || 0);
    const y = Number(box?.y || 0);
    const width = Number(box?.width || 0);
    const height = Number(box?.height || 0);
    return {
      label: markerIndex + 1,
      center: {
        x: x + width / 2,
        y: y + height / 2
      },
      rect: {
        x,
        y,
        width,
        height
      }
    };
  }).filter((item) => Number.isFinite(item.center.x) && Number.isFinite(item.center.y));
}

function unionBoxes(boxes = []) {
  const valid = boxes
    .map((box) => ({
      x: Number(box?.x || 0),
      y: Number(box?.y || 0),
      width: Number(box?.width || 0),
      height: Number(box?.height || 0)
    }))
    .filter((box) => Number.isFinite(box.x) && Number.isFinite(box.y) && box.width > 0 && box.height > 0);
  if (!valid.length) return null;
  const left = Math.min(...valid.map((box) => box.x));
  const top = Math.min(...valid.map((box) => box.y));
  const right = Math.max(...valid.map((box) => box.x + box.width));
  const bottom = Math.max(...valid.map((box) => box.y + box.height));
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
}

function boxesToPreviewRects(boxes = []) {
  const union = unionBoxes(boxes);
  if (!union) return [];
  const padX = union.width <= 120 ? 12 : 16;
  const padY = union.height <= 48 ? 10 : 14;
  return [{
    x: Math.max(0, union.x - padX),
    y: Math.max(0, union.y - padY),
    width: union.width + padX * 2,
    height: union.height + padY * 2
  }];
}

export async function generateIssuePreviewScreenshots(webContents, issues = [], outputDir, options = {}) {
  if (!Array.isArray(issues) || !issues.length) return issues;
  await fs.mkdir(outputDir, { recursive: true });
  const updated = [];
  for (let index = 0; index < issues.length; index += 1) {
    const issue = issues[index];
    if (isGlobalIssue(issue)) {
      updated.push({
        ...issue,
        previewImage: options.sharedPreviewImage || issue.previewImage || '',
        previewMarkers: [],
        previewRects: []
      });
      continue;
    }
    const focusTargets = Array.isArray(issue?.focusTargets) ? issue.focusTargets.filter(Boolean) : [];
    const focusBoxes = Array.isArray(issue?.focusBoxes) ? issue.focusBoxes.filter(Boolean) : [];
    if (!focusTargets.length && !focusBoxes.length) {
      updated.push(issue);
      continue;
    }

    const sourceBoxes = focusTargets.length
      ? focusTargets.map((target) => target?.box || {})
      : focusBoxes;
    const previewMarkers = boxesToPreviewMarkers(sourceBoxes);
    const previewRects = boxesToPreviewRects(sourceBoxes);

    updated.push({
      ...issue,
      previewImage: options.sharedPreviewImage || issue.previewImage || '',
      previewMarkers,
      previewRects
    });
    options.onProgress?.({
      phase: 'issue-preview:written',
      message: `问题定位标记已生成：${issue.title || `问题 ${index + 1}`}`,
      filePath: options.sharedPreviewImage || '',
      issueIndex: index
    });
  }
  return updated;
}
