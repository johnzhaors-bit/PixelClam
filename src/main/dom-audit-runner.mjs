#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectDomSnapshot } from './dom-snapshot.mjs';
import { auditComponent, mergeComponentResults } from './component-audit.mjs';
import { auditLayout } from './layout-audit.mjs';
import { loadModelConfig } from './model-client.mjs';

function option(name, fallback = '') {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) || fallback;
}

function flag(name) {
  return ['1', 'true', 'yes'].includes(option(name).toLowerCase());
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function safeId(value, label) {
  const id = String(value || '').trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`${label}只能包含字母、数字、下划线和短横线：${id}`);
  return id;
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function resolveStandard({ standardsRoot, skin, componentFamily, directStandard }) {
  if (directStandard) return path.resolve(directStandard);
  const base = path.resolve(standardsRoot, skin, 'components');
  for (const extension of ['json', 'md']) {
    const candidate = path.join(base, `${componentFamily}.${extension}`);
    if (await pathExists(candidate)) return candidate;
  }
  throw new Error(`当前皮肤缺少组件规范：${skin}/components/${componentFamily}.{json|md}`);
}

const mode = option('mode', 'dom').toLowerCase();
if (!['dom', 'image'].includes(mode)) throw new Error('--mode 只能是 dom 或 image');

const components = option('components', option('component', 'button'))
  .split(',')
  .map((item) => safeId(item, '组件名'))
  .filter(Boolean);
const directStandard = option('standard');
if (directStandard && components.length !== 1) throw new Error('--standard 只适用于单组件；多组件请使用 --standards-root 和 --skin');

const skin = safeId(option('skin', 'default'), '皮肤名');
const standardsRoot = option('standards-root');
if (!directStandard && !standardsRoot) throw new Error('缺少规范：请提供 --standard，或同时提供 --standards-root 与 --skin');

const runId = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
const home = process.env.UXCHECKER_HOME || path.join(os.homedir(), 'Documents', 'UXChecker-2');
const outDir = path.resolve(option('out', path.join(home, 'runs', runId)));
await fs.mkdir(outDir, { recursive: true });

let evidencePath;
let source;
if (mode === 'image') {
  evidencePath = path.resolve(option('image'));
  if (!option('image')) throw new Error('图片模式需要 --image=<图片路径>');
  if (!(await pathExists(evidencePath))) throw new Error(`找不到图片：${evidencePath}`);
  source = { imagePath: evidencePath };
} else if (option('snapshot')) {
  evidencePath = path.resolve(option('snapshot'));
  if (!(await pathExists(evidencePath))) throw new Error(`找不到 DOM 快照：${evidencePath}`);
  source = { snapshotPath: evidencePath };
} else {
  const url = option('url');
  if (!url) throw new Error('DOM 模式需要 --url=<页面地址> 或 --snapshot=<快照路径>');
  emit({ phase: 'snapshot:start', message: '冻结登录后的完整运行态 DOM', outDir });
  const snapshot = await collectDomSnapshot({ url, outDir });
  evidencePath = snapshot.modelSnapshotPath;
  source = {
    url,
    snapshotPath: snapshot.snapshotPath,
    modelSnapshotPath: snapshot.modelSnapshotPath,
    screenshotPath: snapshot.screenshotPath
  };
  emit({ phase: 'snapshot:done', message: 'DOM 快照已冻结，不需要模型重新登录', snapshotPath: snapshot.snapshotPath, modelSnapshotPath: evidencePath });
}

const configPath = path.resolve(option('config', path.join(home, 'config', 'model-config.json')));
const config = await loadModelConfig(configPath);
if (!config.enabled) throw new Error(`模型未启用，请检查 ${configPath}`);

const defaultLayoutStandard = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../user-data/skills/Paletx-MultiSkin-Audit/standards/paletx-core/layout/layout-audit-pack-v1.json'
);
const layoutStandardPath = path.resolve(option('layout-standard', defaultLayoutStandard));
if (!(await pathExists(layoutStandardPath))) throw new Error(`找不到布局规范：${layoutStandardPath}`);

const standardEntries = [];
for (const componentFamily of components) {
  standardEntries.push({
    componentFamily,
    standardPath: await resolveStandard({ standardsRoot, skin, componentFamily, directStandard })
  });
}
const auditPlanPath = path.join(outDir, 'audit-plan.json');
await fs.writeFile(auditPlanPath, JSON.stringify({
  schemaVersion: 'component-audit-plan-v1',
  mode,
  skin,
  createdAt: new Date().toISOString(),
  steps: standardEntries.map((item) => ({ ...item, status: 'pending' }))
}, null, 2), 'utf8');

let auditEntries = standardEntries;
let skippedAbsentFamilies = [];
let originRun = null;
if (mode === 'dom' && !flag('skip-origin')) {
  const { classifyDomComponentOrigins } = await import('./dom-component-origin.mjs');
  emit({ phase: 'origin:start', message: '盘点当前页面实际出现的组件族' });
  const origin = await classifyDomComponentOrigins({
    evidencePath,
    standards: standardEntries,
    config,
    artifactDir: outDir,
    onProgress: emit
  });
  originRun = origin;
  skippedAbsentFamilies = origin.skippedAbsentFamilies;
  const skipped = new Set(skippedAbsentFamilies);
  auditEntries = standardEntries.filter((item) => !skipped.has(item.componentFamily));
  const plan = JSON.parse(await fs.readFile(auditPlanPath, 'utf8'));
  for (const step of plan.steps) {
    if (skippedAbsentFamilies.includes(step.componentFamily)) {
      step.status = 'skipped-not-present';
      step.reason = 'DOM来源盘点高置信确认当前页面未出现该组件族，不发起组件验收调用';
    }
  }
  plan.originInventoryPath = origin.resultPath;
  await fs.writeFile(auditPlanPath, JSON.stringify(plan, null, 2), 'utf8');
  emit({ phase: 'origin:done', message: `页面未出现 ${skippedAbsentFamilies.length} 个；继续验收 ${auditEntries.length} 个`, skippedAbsentFamilies });
}

let layoutRun = null;
if (!flag('skip-layout')) {
  emit({ phase: 'layout:start', message: '开始独立的整页布局验收；布局规范不随皮肤重复' });
  const layoutOutput = await auditLayout({
    mode,
    evidencePath,
    standardPath: layoutStandardPath,
    config,
    artifactDir: outDir,
    onProgress: emit
  });
  const layoutResultPath = path.join(outDir, 'layout-result.json');
  await fs.writeFile(layoutResultPath, JSON.stringify(layoutOutput.result, null, 2), 'utf8');
  layoutRun = { standardPath: layoutStandardPath, resultPath: layoutResultPath, ...layoutOutput };
  emit({ phase: 'layout:done', message: '整页布局验收完成', resultPath: layoutResultPath });
}

const componentRuns = [];
for (const standardEntry of auditEntries) {
  const { componentFamily, standardPath } = standardEntry;
  emit({
    phase: 'component:start',
    message: `开始验收 ${skin}/${componentFamily}，本轮只加载这一份规范`,
    componentFamily,
    standardPath
  });
  const output = await auditComponent({
    mode,
    evidencePath,
    standardPath,
    componentFamily,
    config,
    artifactDir: outDir,
    onProgress: emit,
    reuseEvidencePrefix: true,
    reasoningEffort: option('reasoning-effort', 'low')
  });
  const resultPath = path.join(outDir, `${componentFamily}-result.json`);
  await fs.writeFile(resultPath, JSON.stringify(output.result, null, 2), 'utf8');
  componentRuns.push({ componentFamily, standardPath, resultPath, ...output });
  const plan = JSON.parse(await fs.readFile(auditPlanPath, 'utf8'));
  const step = plan.steps.find((item) => item.componentFamily === componentFamily);
  if (step) {
    step.status = 'completed';
    step.resultPath = resultPath;
  }
  await fs.writeFile(auditPlanPath, JSON.stringify(plan, null, 2), 'utf8');
  emit({
    phase: 'component:done',
    message: `${componentFamily} 验收完成`,
    componentFamily,
    resultPath
  });
}

const report = mergeComponentResults({ mode, skin, source, componentRuns, skippedAbsentFamilies, originRun, layoutRun });
const reportPath = path.join(outDir, 'report.json');
await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
emit({ phase: 'done', message: '所有组件结果已确定性合并', reportPath, summary: report.summary });
