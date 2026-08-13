#!/usr/bin/env node
/**
 * Render an interactive HTML UX audit report from JSON data.
 *
 * Usage:
 *   node scripts/render-interactive-report.mjs \
 *     --data=/path/to/report-data.json \
 *     --name=数据补采配置
 *
 * By default the HTML report and normalized JSON snapshot are written to the
 * UXChecker user workspace reports directory, next to the skills directory.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function getCliOption(name, fallback = null) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length).trim() : fallback;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function timestamp(date = new Date()) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('') + '-' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('');
}

function safeFileName(value) {
  const text = String(value || 'ux-audit-report')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|#%{}^~[\]`]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

  return text || 'ux-audit-report';
}

function isRemoteUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

function resolveLocalFile(value, cwd) {
  const text = String(value || '').trim();
  if (!text || isRemoteUrl(text)) {
    return null;
  }

  if (text.startsWith('file://')) {
    return fileURLToPath(text);
  }

  return path.isAbsolute(text) ? text : path.resolve(cwd, text);
}

async function copyIssuePreviewImages(report, reportDir, cwd, outPath) {
  if (!Array.isArray(report?.issues) || !report.issues.length) return;
  const issueAssetDir = path.join(reportDir, 'assets', 'issues');
  await fs.mkdir(issueAssetDir, { recursive: true });
  for (let index = 0; index < report.issues.length; index += 1) {
    const issue = report.issues[index];
    const previewPath = resolveLocalFile(issue?.previewImage, cwd);
    if (!previewPath) continue;
    try {
      await fs.access(previewPath);
      const ext = path.extname(previewPath) || '.png';
      const fileName = `${String(index + 1).padStart(3, '0')}${ext}`;
      const outputPath = path.join(issueAssetDir, fileName);
      await fs.copyFile(previewPath, outputPath);
      issue.previewImage = path.relative(path.dirname(outPath), outputPath).split(path.sep).join('/');
    } catch {
      issue.previewImage = '';
    }
  }
}

const dataArg = getCliOption('data');
const outArg = getCliOption('out');
const nameArg = getCliOption('name');
const templateArg = getCliOption('template');
const dataOutArg = getCliOption('data-out');

if (!dataArg) {
  console.error('Usage: node scripts/render-interactive-report.mjs --data=/path/report.json [--name=report-name] [--out=/path/report.html]');
  process.exit(1);
}

const cwd = process.cwd();
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.resolve(scriptDir, '..');
const templatePath = templateArg
  ? path.resolve(cwd, templateArg)
  : path.join(skillDir, 'assets/report-templates/interactive-html-report.template.html');
const dataPath = path.resolve(cwd, dataArg);

const template = await fs.readFile(templatePath, 'utf8');
const data = JSON.parse(await fs.readFile(dataPath, 'utf8'));
if (!data.targetImage) {
  const evidenceScreenshotPath = path.resolve(path.dirname(dataPath), 'screenshot.png');
  try {
    await fs.access(evidenceScreenshotPath);
    data.targetImage = evidenceScreenshotPath;
  } catch {
    const nestedEvidenceScreenshotPath = path.resolve(path.dirname(dataPath), 'evidence', 'screenshot.png');
    try {
      await fs.access(nestedEvidenceScreenshotPath);
      data.targetImage = nestedEvidenceScreenshotPath;
    } catch {
      // Keep empty when no fallback screenshot exists.
    }
  }
}
const reportBaseName = safeFileName(
  nameArg || data.slug || data.reportName || data.title || data.targetName || 'ux-audit-report'
);
const reportName = `${reportBaseName}-${timestamp()}`;
const workspaceRoot = process.env.UXCHECKER_HOME || path.resolve(skillDir, '..', '..');
const reportsDir = process.env.UXCHECKER_REPORTS_DIR || path.join(workspaceRoot, 'reports');
const reportDir = outArg ? path.dirname(path.resolve(cwd, outArg)) : path.join(reportsDir, reportName);
const outPath = outArg ? path.resolve(cwd, outArg) : path.join(reportDir, 'index.html');
const dataOutPath = dataOutArg
  ? path.resolve(cwd, dataOutArg)
  : path.join(reportDir, 'report.json');
const targetImagePath = resolveLocalFile(data.targetImage, cwd);

if (targetImagePath) {
  try {
    await fs.access(targetImagePath);
    const assetDir = path.join(reportDir, 'assets');
    const imageName = safeFileName(path.basename(targetImagePath));
    const imageOutPath = path.join(assetDir, imageName);
    await fs.mkdir(assetDir, { recursive: true });
    await fs.copyFile(targetImagePath, imageOutPath);
    data.targetImage = path.relative(path.dirname(outPath), imageOutPath).split(path.sep).join('/');
  } catch {
    data.targetImage = '';
    data.imageWarning = `截图文件未找到或无法复制：${targetImagePath}`;
  }
}

await copyIssuePreviewImages(data, reportDir, cwd, outPath);

const json = JSON.stringify(data).replace(/</g, '\\u003c');
const html = template.replace('__REPORT_JSON__', json);

await fs.mkdir(reportDir, { recursive: true });
await fs.writeFile(outPath, html, 'utf8');
await fs.writeFile(dataOutPath, JSON.stringify(data, null, 2), 'utf8');

console.log(JSON.stringify({
  ok: true,
  reportDir,
  out: outPath,
  dataOut: dataOutPath,
  template: templatePath,
  data: dataPath
}, null, 2));
