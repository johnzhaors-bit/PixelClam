#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectRuntimeUi } from './collector.mjs';
import { auditRuntime } from './rule-engine.mjs';
import { normalizeRuntimeEvidence } from './evidence-normalizer.mjs';
import { writeSafeEvidence } from './safe-evidence-builder.mjs';
import { resolveRuntimeOpenItems } from './runtime-resolution.mjs';
import { generateIssuePreviewScreenshots } from './runtime-issue-previews.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..', '..');
const nodeBin = process.env.UXCHECKER_NODE_PATH || process.execPath;
const APP_NAME = 'UXChecker-2';

function getCliOption(name, fallback = null) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length).trim() || fallback : fallback;
}

function emit(event) {
  console.log(JSON.stringify(event));
}

function safeName(value) {
  return String(value || '运行态页面')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|#%{}^~[\]`]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || '运行态页面';
}

function timestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
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

function userDataRoot() {
  return process.env.UXCHECKER_HOME || path.join(os.homedir(), 'Documents', APP_NAME);
}

function userReportsRoot() {
  return path.join(userDataRoot(), 'reports');
}

function userRunsRoot() {
  return path.join(userDataRoot(), 'runs');
}

function userSkillsRoot() {
  return path.join(userDataRoot(), 'skills');
}

function userConfigRoot() {
  return path.join(userDataRoot(), 'config');
}

function browserProfileRoot() {
  if (process.env.UXCHECKER_BROWSER_PROFILE) return process.env.UXCHECKER_BROWSER_PROFILE;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_NAME, 'browser-profile');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME, 'browser-profile');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), APP_NAME, 'browser-profile');
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readSkillManifest(skillDir) {
  let manifest = {};
  try {
    manifest = JSON.parse(await fs.readFile(path.join(skillDir, 'skill.json'), 'utf8'));
  } catch {
    // Legacy skills use the conventional entry points.
  }
  const entryPath = path.resolve(skillDir, manifest.entry || 'SKILL.md');
  const rendererPath = path.resolve(skillDir, manifest.reportRenderer || 'scripts/render-interactive-report.mjs');
  const relativeEntry = path.relative(skillDir, entryPath);
  const relativeRenderer = path.relative(skillDir, rendererPath);
  if (
    relativeEntry.startsWith('..') ||
    relativeRenderer.startsWith('..') ||
    !(await pathExists(entryPath)) ||
    !(await pathExists(rendererPath))
  ) {
    throw new Error(`Skill 无效：${path.basename(skillDir)}`);
  }
  return {
    id: String(manifest.id || path.basename(skillDir)),
    name: String(manifest.name || path.basename(skillDir)),
    version: String(manifest.version || '0.0.0'),
    path: skillDir,
    rendererPath
  };
}

async function resolveSkill() {
  const cliSkillDir = getCliOption('skillDir');
  if (cliSkillDir) return readSkillManifest(path.resolve(cliSkillDir));

  const requestedId = getCliOption('skillId');
  await fs.mkdir(userSkillsRoot(), { recursive: true });
  const entries = await fs.readdir(userSkillsRoot(), { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      skills.push(await readSkillManifest(path.join(userSkillsRoot(), entry.name)));
    } catch {
      // Ignore invalid folders.
    }
  }
  if (!skills.length) throw new Error(`请将完整 Skill 文件夹复制到 ${userSkillsRoot()}`);
  const skill = requestedId
    ? skills.find((item) => item.id === requestedId || path.basename(item.path) === requestedId)
    : skills[0];
  if (!skill) throw new Error(`找不到已选择的 Skill：${requestedId}`);
  return skill;
}

async function runRender(skill, reportDataPath, reportName) {
  const script = skill.rendererPath;
  const reportDir = path.join(userReportsRoot(), `${safeName(reportName)}-${timestamp()}`);
  const outPath = path.join(reportDir, 'index.html');
  const dataOutPath = path.join(reportDir, 'report.json');
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin, [
      script,
      `--data=${reportDataPath}`,
      `--name=${reportName}`,
      `--out=${outPath}`,
      `--data-out=${dataOutPath}`
    ], {
      cwd: appRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        UXCHECKER_HOME: userDataRoot(),
        UXCHECKER_REPORTS_DIR: userReportsRoot()
      }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `报告渲染失败，退出码 ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`报告渲染输出无法解析：${stdout}`));
      }
    });
  });
}

function modelConfigPath() {
  return path.join(userConfigRoot(), 'model-config.json');
}

function mergeAiAudit(baseAudit, aiResult) {
  if (!aiResult) return { audit: baseAudit, aiEnabled: false };
  const aiIssues = Array.isArray(aiResult.issues) ? aiResult.issues : [];
  const aiComponents = Array.isArray(aiResult.components) ? aiResult.components : [];
  const aiDimensions = Array.isArray(aiResult.dimensions) ? aiResult.dimensions : [];
  const score = Number.isFinite(Number(aiResult.score))
    ? Math.max(0, Math.min(100, Math.round(Number(aiResult.score))))
    : baseAudit.score;
  const stars = aiResult.stars || (
    score >= 95 ? '★★★★★' : score >= 85 ? '★★★★☆' : score >= 70 ? '★★★☆☆' : score >= 60 ? '★★☆☆☆' : '★☆☆☆☆'
  );
  return {
    aiEnabled: true,
    audit: {
      ...baseAudit,
      score,
      stars,
      issues: [
        ...aiIssues.map((item) => ({
          issueSource: 'ai',
          issueSourceLabel: '大模型识别',
          severity: item.severity || 'minor',
          severityLabel: item.severityLabel || (item.severity === 'severe' ? '严重' : item.severity === 'medium' ? '中等' : '轻微'),
          title: item.title || 'AI 识别问题',
          description: item.description || '',
          delta: item.delta || '',
          previewImage: item.previewImage || '',
          previewMarkers: Array.isArray(item.previewMarkers) ? item.previewMarkers : []
        })),
        ...baseAudit.issues.map((item) => ({
          issueSource: item.issueSource || 'rule',
          issueSourceLabel: item.issueSourceLabel || '程序规则',
          ...item
        }))
      ],
      dimensions: aiDimensions.length ? aiDimensions : baseAudit.dimensions,
      components: aiComponents.length ? aiComponents : baseAudit.components,
      summary: aiResult.summary || ''
    }
  };
}

function withRuleIssueSource(issues) {
  return (Array.isArray(issues) ? issues : []).map((item) => ({
    issueSource: item?.issueSource || 'rule',
    issueSourceLabel: item?.issueSourceLabel || '程序规则',
    ...item
  }));
}

function issueSourceMetrics(issues) {
  const list = Array.isArray(issues) ? issues : [];
  const aiCount = list.filter((item) => item?.issueSource === 'ai').length;
  const ruleCount = list.filter((item) => (item?.issueSource || 'rule') === 'rule').length;
  return [
    { label: 'AI 识别', value: String(aiCount) },
    { label: '程序规则', value: String(ruleCount) }
  ];
}

function aiStatusMetrics(aiStatus) {
  if (!aiStatus) return [];
  const statusLabel = aiStatus.success
    ? '成功'
    : aiStatus.fallback
      ? '失败后回退'
      : aiStatus.state === 'skipped'
        ? '已跳过'
        : aiStatus.enabled
          ? '未执行'
          : '未启用';
  const roundLabel = aiStatus.totalRounds
    ? `${aiStatus.roundsCompleted || 0}/${aiStatus.totalRounds}`
    : (aiStatus.mode === 'single' && aiStatus.attempted ? '1/1' : '—');
  return [
    { label: 'AI 状态', value: statusLabel },
    { label: 'AI 模式', value: aiStatus.mode === 'multiround' ? '多轮' : aiStatus.mode === 'single' ? '单轮' : '未使用' },
    { label: 'AI 轮次', value: roundLabel }
  ];
}

function aiStatusLimitations(aiStatus) {
  if (!aiStatus) return [];
  if (aiStatus.success) {
    return [aiStatus.message || `本次已启用大模型分析：${aiStatus.model || aiStatus.provider}`];
  }
  if (aiStatus.fallback) {
    return [aiStatus.message || 'AI 分析失败，已回退确定性规则'];
  }
  if (aiStatus.state === 'skipped') {
    return [aiStatus.message || 'AI 已跳过，本次仅使用确定性规则'];
  }
  if (!aiStatus.enabled) {
    return [aiStatus.message || '本次未启用大模型分析，仅使用确定性规则'];
  }
  return [aiStatus.message || 'AI 状态未知'];
}

async function maybeRunAiAnalysis({ runtime, audit, skill, runDir }) {
  const modelClient = await import(pathToFileURL(path.join(appRoot, 'src', 'main', 'model-client.mjs')).href);
  const config = await modelClient.loadModelConfig(modelConfigPath());
  const baseStatus = {
    enabled: Boolean(config.enabled),
    attempted: false,
    success: false,
    fallback: false,
    state: config.enabled ? 'idle' : 'disabled',
    provider: config.provider || 'kimi',
    model: config.model || '',
    mode: 'none',
    roundsStarted: 0,
    roundsCompleted: 0,
    totalRounds: 0,
    message: config.enabled ? 'AI 已启用，等待执行' : 'AI 未启用，本次仅使用确定性规则'
  };

  if (!config.enabled) {
    return {
      audit,
      aiAnalysisPath: null,
      aiEvidencePath: null,
      auditPlanPath: null,
      aiRounds: [],
      aiEnabled: false,
      modelName: '',
      aiStatus: baseStatus
    };
  }

  if (!config.apiKey) {
    emit({ phase: 'ai:skip', message: 'AI 分析已启用，但未配置 API Key，跳过模型分析' });
    return {
      audit,
      aiAnalysisPath: null,
      aiEvidencePath: null,
      auditPlanPath: null,
      aiRounds: [],
      aiEnabled: false,
      modelName: '',
      aiStatus: {
        ...baseStatus,
        state: 'skipped',
        message: 'AI 已启用，但未配置 API Key，已跳过模型分析'
      }
    };
  }

  try {
    emit({ phase: 'ai:start', message: `调用大模型分析：${config.provider || 'kimi'} / ${config.model}` });
    const ai = await modelClient.runAiUxAnalysis({
      config,
      runtime,
      audit,
      skillDir: skill.path,
      skillMeta: {
        id: skill.id,
        name: skill.name,
        baseSkillId: skill.id,
        skinId: '',
        skinName: skill.name || ''
      },
      runDir,
      fetchImpl: globalThis.fetch,
      onProgress: emit
    });
    const merged = mergeAiAudit(audit, ai.analysis);
    const roundList = Array.isArray(ai?.analysis?.rounds) ? ai.analysis.rounds : [];
    const roundIssueTotal = roundList.reduce((sum, round) => sum + Number(round?.issueCount || 0), 0);
    emit({
      phase: 'ai:done',
      message: `AI 分析完成：${ai.model || config.model}`,
      aiAnalysisPath: ai.aiAnalysisPath,
      score: merged.audit.score,
      stars: merged.audit.stars
    });
    return {
      audit: merged.audit,
      aiAnalysisPath: ai.aiAnalysisPath,
      aiEvidencePath: ai.aiEvidencePath,
      auditPlanPath: ai.auditPlanPath || path.join(runDir, 'audit-plan.json'),
      aiRounds: roundList,
      aiEnabled: true,
      modelName: ai.model || config.model,
      aiStatus: {
        ...baseStatus,
        attempted: true,
        success: true,
        state: 'success',
        provider: config.provider || 'kimi',
        model: ai.model || config.model || '',
        mode: roundList.length ? 'multiround' : 'single',
        roundsStarted: roundList.length,
        roundsCompleted: roundList.length,
        totalRounds: roundList.length,
        roundIssueTotal,
        message: roundList.length
          ? `AI 多轮验收完成：${roundList.length} 轮，累计输出 ${roundIssueTotal} 条轮次问题`
          : `AI 单轮验收完成：${ai.model || config.model}`
      }
    };
  } catch (error) {
    const auditPlanPath = path.join(runDir, 'audit-plan.json');
    let auditPlan = null;
    try {
      auditPlan = JSON.parse(await fs.readFile(auditPlanPath, 'utf8'));
      if (Array.isArray(auditPlan.steps)) {
        const current = auditPlan.steps.find((step) => step.status === 'running');
        if (current) current.status = 'failed';
      }
      auditPlan = {
        ...auditPlan,
        status: 'failed',
        failureReason: error?.message || String(error)
      };
      await fs.writeFile(auditPlanPath, JSON.stringify(auditPlan, null, 2), 'utf8');
    } catch {
      auditPlan = null;
    }
    const aiErrorPath = path.join(runDir, 'ai-error.json');
    await fs.writeFile(aiErrorPath, JSON.stringify({
      ok: false,
      createdAt: new Date().toISOString(),
      message: error?.message || String(error),
      stack: error?.stack || ''
    }, null, 2), 'utf8');
    emit({
      phase: 'ai:failed',
      message: `AI 分析失败，已回退确定性规则：${error?.message || String(error)}`,
      aiAnalysisPath: aiErrorPath
    });
    return {
      audit,
      aiAnalysisPath: aiErrorPath,
      aiEvidencePath: null,
      auditPlanPath: auditPlan ? auditPlanPath : null,
      aiRounds: [],
      aiEnabled: false,
      modelName: config.model || '',
      aiStatus: {
        ...baseStatus,
        attempted: true,
        fallback: true,
        state: 'failed',
        totalRounds: Array.isArray(auditPlan?.steps) ? auditPlan.steps.length : 0,
        roundsStarted: Array.isArray(auditPlan?.steps)
          ? auditPlan.steps.filter((step) => step.status === 'running' || step.status === 'done' || step.status === 'failed').length
          : 0,
        roundsCompleted: Array.isArray(auditPlan?.steps)
          ? auditPlan.steps.filter((step) => step.status === 'done').length
          : 0,
        message: `AI 分析失败，已回退确定性规则：${error?.message || String(error)}`,
        failureReason: error?.message || String(error)
      }
    };
  }
}

async function main() {
  const url = getCliOption('url');
  if (!url) throw new Error('缺少 URL');

  const viewport = getCliOption('viewport', '1440x900');
  const manualLogin = /^(1|true|yes|on)$/i.test(String(getCliOption('manualLogin', 'false')));
  const manualWaitMs = Number(getCliOption('manualWaitMs', 90000));
  const runId = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const runDir = path.join(userRunsRoot(), runId);
  await fs.mkdir(runDir, { recursive: true });

  emit({ phase: 'run:init', message: '创建检测任务', runDir });
  const skill = await resolveSkill();
  emit({ phase: 'skill:resolved', message: `使用 Skill：${skill.name} ${skill.version}`, skillDir: skill.path });

  const runtimePath = path.join(runDir, 'runtime.json');
  const screenshotPath = path.join(runDir, 'screenshot.png');
  const runtime = await collectRuntimeUi({
    url,
    out: runtimePath,
    screenshot: screenshotPath,
    viewport,
    waitUntil: getCliOption('waitUntil', 'domcontentloaded'),
    ignoreHTTPSErrors: true,
    manualLogin,
    manualWaitMs,
    userDataDir: browserProfileRoot(),
    preserveSession: true
  });

  try {
    const normalizedEvidence = normalizeRuntimeEvidence(runtime);
    runtime.normalizedEvidence = normalizedEvidence;
    runtime.normalizedElements = normalizedEvidence.elements;
    const normalizedEvidencePath = path.join(runDir, 'normalized-evidence.json');
    await fs.writeFile(normalizedEvidencePath, JSON.stringify(normalizedEvidence, null, 2), 'utf8');
    emit({
      phase: 'evidence:normalized',
      message: `证据归一化完成：原始 ${normalizedEvidence.rawElementCount} 个，有效 ${normalizedEvidence.effectiveElementCount} 个`,
      normalizedEvidencePath,
      typeCounts: normalizedEvidence.typeCounts,
      regionCounts: normalizedEvidence.regionCounts
    });
    const safeEvidencePath = path.join(runDir, 'safe-evidence.json');
    const safeEvidence = await writeSafeEvidence(runtime, safeEvidencePath);
    emit({
      phase: 'evidence:safe',
      message: `安全证据生成完成：${safeEvidence.elements.length} 个脱敏视觉对象`,
      safeEvidencePath
    });

    emit({ phase: 'runtime-resolution:start', message: '执行 runtime-verify 开放项识别与补证判定' });
    const runtimeResolutionResult = await resolveRuntimeOpenItems({
      runtime,
      normalizedEvidence,
      skill,
      runId,
      runDir
    });
    emit({
      phase: 'runtime-resolution:done',
      message: runtimeResolutionResult.runtimeResolutionSummary.message,
      runtimeEvidencePath: runtimeResolutionResult.runtimeEvidencePath,
      runtimeResolutionPath: runtimeResolutionResult.runtimeResolutionPath,
      runtimeResolutionLogPath: runtimeResolutionResult.runtimeResolutionLogPath,
      runtimeResolutionSummary: runtimeResolutionResult.runtimeResolutionSummary
    });

    emit({ phase: 'rules:start', message: '执行 PaletX Pro 规则对比' });
    let audit = auditRuntime(runtime);
    const hintCounts = {};
    for (const element of normalizedEvidence.elements || []) {
      for (const hint of element.semanticHints || ['unknown']) {
        hintCounts[hint] = (hintCounts[hint] || 0) + 1;
      }
    }
    const evidenceSummaryPath = path.join(runDir, 'evidence-summary.json');
    await fs.writeFile(
      evidenceSummaryPath,
      JSON.stringify(
        {
          title: runtime.title,
          url: runtime.url,
          viewport: runtime.viewport,
          screenshot: screenshotPath,
          runtimeJson: runtimePath,
          normalizedEvidenceJson: normalizedEvidencePath,
          safeEvidenceJson: safeEvidencePath,
          runtimeEvidenceJson: runtimeResolutionResult.runtimeEvidencePath,
          runtimeResolutionJson: runtimeResolutionResult.runtimeResolutionPath,
          runtimeResolutionLog: runtimeResolutionResult.runtimeResolutionLogPath,
          rawElementCount: runtime.elements.length,
          effectiveElementCount: normalizedEvidence.effectiveElementCount,
          droppedElementCount: normalizedEvidence.droppedElementCount,
          hintCounts,
          typeCounts: normalizedEvidence.typeCounts,
          regionCounts: normalizedEvidence.regionCounts,
          regions: normalizedEvidence.regions,
          sampleElements: normalizedEvidence.elements.slice(0, 30).map((element) => ({
            selector: element.selector,
            tagName: element.tagName,
            role: element.role,
            text: element.text,
            box: element.box,
            semanticHints: element.semanticHints,
            auditType: element.auditType,
            auditRegion: element.auditRegion,
            style: {
              color: element.style?.color,
              backgroundColor: element.style?.backgroundColor,
              borderRadius: element.style?.borderRadius,
              fontSize: element.style?.fontSize,
              fontWeight: element.style?.fontWeight
            }
          }))
        },
        null,
        2
      ),
      'utf8'
    );
    emit({
      phase: 'evidence:summary',
      message: `证据摘要完成：${normalizedEvidence.effectiveElementCount} 个有效对象`,
      runtimePath,
      evidenceSummaryPath,
      normalizedEvidencePath,
      safeEvidencePath,
      hintCounts
    });
    const targetName = runtime.title || new URL(url).hostname;
    const runtimeResolutionSummary = runtimeResolutionResult.runtimeResolutionSummary;
    const runtimeResolutionComponents = [];
    if (runtimeResolutionSummary.discoveredCount > 0) {
      runtimeResolutionComponents.push({
        name: 'Runtime Resolution / 开放项补证队列',
        status: runtimeResolutionSummary.pendingCount > 0 ? '待补证' : '已确认',
        actual: `本页命中 ${runtimeResolutionSummary.discoveredCount} 个 runtime-verify 开放项；已升级 ${runtimeResolutionSummary.resolvedCount} 个，待补证 ${runtimeResolutionSummary.pendingCount} 个。`,
        standard: 'runtime-verify 项在 requiredFields 未齐备前不得硬扣分；补证完成后才能升级为 confirmed 并进入正式判定。',
        suggestion: runtimeResolutionSummary.pendingCount > 0
          ? '后续需要在运行态补采 hover/active/disabled 或更细粒度对象字段，才能把待补证项升级为正式硬规则。'
          : '当前命中的 runtime-verify 项已具备升级条件，可在后续规则里纳入正式扣分。'
      });
    }
    if (runtimeResolutionSummary.discoveredCount === 0) {
      runtimeResolutionComponents.push({
        name: 'Runtime Resolution / 开放项补证队列',
        status: '未命中',
        actual: '当前页面未命中 sendbox / event-preview 等剩余 runtime-verify 开放项。',
        standard: '只有页面真实出现相关对象时，才进入 runtime-resolution 补证链。',
        suggestion: '本页无需额外补证，可直接按基础规则验收。'
      });
    }
    for (const item of runtimeResolutionResult.runtimeResolution.pendingItems || []) {
      runtimeResolutionComponents.push({
        name: `Runtime Verify / ${item.id}`,
        status: '待补证',
        actual: `已命中该对象，当前覆盖状态：${(item.coveredStates || []).join(' / ') || '无'}；已满足字段 ${item.satisfiedFields?.length || 0} 个，缺失字段 ${item.missingFields?.length || 0} 个。`,
        standard: `该项要求状态：${(item.requiredStates || []).join(' / ') || 'default'}；只有 requiredFields 全齐且状态覆盖完成后，才允许进入正式硬扣分。`,
        suggestion: `本次未升级原因：${item.reason}。后续优先补采缺失状态或字段，再重新执行验收。`
      });
    }
    for (const item of runtimeResolutionResult.runtimeResolution.resolvedItems || []) {
      runtimeResolutionComponents.push({
        name: `Runtime Verify / ${item.id}`,
        status: '已确认',
        actual: `已命中该对象，当前覆盖状态：${(item.coveredStates || []).join(' / ') || '无'}；requiredFields 已齐备，可进入正式判定。`,
        standard: `该项要求状态：${(item.requiredStates || []).join(' / ') || 'default'}；升级后允许按对应 owner pass 进入正式评分。`,
        suggestion: '这类项后续可继续从“待补证”过渡到真正的硬规则校验与扣分。'
      });
    }

    const aiResult = await maybeRunAiAnalysis({
      runtime,
      audit,
      skill,
      runDir
    });
    audit = aiResult.audit;
    const sourcedIssues = withRuleIssueSource(audit.issues);

    const reportData = {
      title: `${targetName || '运行态页面'} UX 运行态验收报告`,
      targetName,
      targetImage: screenshotPath,
      mode: `检查方式：Playwright 运行态采集；视口 ${runtime.viewport?.width}×${runtime.viewport?.height}，DPR ${runtime.viewport?.devicePixelRatio}`,
      standard: '标准：公司 UI 规范 / PaletX Pro；不按品牌、产品名、页面标题或 logo 文案扣分，仅按本页实际出现元素评分',
      score: audit.score,
      stars: audit.stars,
      summary: `已通过 Playwright 打开真实页面并采集 ${runtime.elements.length} 个可见候选元素，归一化后得到 ${normalizedEvidence.effectiveElementCount} 个有效验收对象。报告基于当前页实际出现控件评分，未出现且需求未要求的组件不参与扣分。`,
      metrics: [
        { label: '总分', value: String(audit.score) },
        { label: '星级', value: audit.stars },
        { label: '有效对象', value: String(normalizedEvidence.effectiveElementCount) },
        { label: '原始候选', value: String(runtime.elements.length) },
        { label: '视口', value: `${runtime.viewport?.width}×${runtime.viewport?.height}` },
        { label: '待补证项', value: String(runtimeResolutionSummary.pendingCount) },
        ...issueSourceMetrics(sourcedIssues),
        ...aiStatusMetrics(aiResult.aiStatus)
      ],
      viewport: runtime.viewport || null,
      issues: sourcedIssues,
      dimensions: audit.dimensions,
      components: [...runtimeResolutionComponents, ...audit.components],
      skill: {
        id: skill.id,
        name: skill.name,
        version: skill.version
      },
      model: {
        enabled: aiResult.aiEnabled,
        name: aiResult.modelName || ''
      },
      aiStatus: aiResult.aiStatus || null,
      aiRounds: Array.isArray(aiResult.aiRounds) ? aiResult.aiRounds : [],
      limitations: [
        '当前已接入部分运行态补采能力，可补采 default / hover / active；disabled / loading / 复杂联动态仍将继续增强。',
        '当前评分优先基于运行态证据；若 AI 可用，会在确定性规则基础上补充多轮组件与布局分析。',
        '本次不以品牌、产品名、页面标题或 logo 文案作为扣分依据，只按视觉 token 和组件表现验收。',
        runtimeResolutionSummary.pendingCount > 0
          ? `当前仍有 ${runtimeResolutionSummary.pendingCount} 个 runtime-verify 项待补证，它们不会进入硬扣分。`
          : '本次命中的 runtime-verify 开放项已完成基础判定接线。'
      ].concat(aiStatusLimitations(aiResult.aiStatus)),
      runtimeResolution: runtimeResolutionResult.runtimeResolution,
      runtimeResolutionSummary,
      rawEvidence: {
        runtimeJson: runtimePath,
        evidenceSummary: evidenceSummaryPath,
        normalizedEvidence: normalizedEvidencePath,
        safeEvidence: safeEvidencePath,
        aiAnalysis: aiResult.aiAnalysisPath,
        aiEvidence: aiResult.aiEvidencePath,
        auditPlan: aiResult.auditPlanPath || null,
        runtimeEvidence: runtimeResolutionResult.runtimeEvidencePath,
        runtimeResolution: runtimeResolutionResult.runtimeResolutionPath,
        runtimeResolutionLog: runtimeResolutionResult.runtimeResolutionLogPath,
        requestedUrl: url
      }
    };

    const issuePreviewAssetDir = path.join(runDir, 'issue-previews');
    reportData.issues = await generateIssuePreviewScreenshots(
      null,
      reportData.issues,
      issuePreviewAssetDir,
      {
        sharedPreviewImage: screenshotPath,
        onProgress: emit
      }
    );

    const reportDataPath = path.join(runDir, 'report-data.json');
    await fs.writeFile(reportDataPath, JSON.stringify(reportData, null, 2), 'utf8');

    emit({ phase: 'report:render', message: '生成 HTML 验收报告' });
    const renderResult = await runRender(skill, reportDataPath, `${safeName(targetName)}-UX运行态验收报告`);

    emit({
      phase: 'run:done',
      message: '检测完成',
      score: audit.score,
      stars: audit.stars,
      reportPath: renderResult.out,
      reportDir: renderResult.reportDir,
      skillDir: skill.path,
      skillId: skill.id,
      skillVersion: skill.version,
      screenshot: screenshotPath,
      runtimePath,
      evidenceSummaryPath,
      normalizedEvidencePath,
      safeEvidencePath,
      aiEvidencePath: aiResult.aiEvidencePath,
      aiAnalysisPath: aiResult.aiAnalysisPath,
      auditPlanPath: aiResult.auditPlanPath || null,
      runtimeEvidencePath: runtimeResolutionResult.runtimeEvidencePath,
      runtimeResolutionPath: runtimeResolutionResult.runtimeResolutionPath,
      runtimeResolutionLogPath: runtimeResolutionResult.runtimeResolutionLogPath,
      aiStatus: aiResult.aiStatus || null
    });
  } finally {
    await runtime.__session?.dispose?.().catch(() => {});
  }
}

main().catch((error) => {
  emit({ phase: 'run:error', message: error?.message || String(error), stack: error?.stack });
  process.exit(1);
});
