const { app, BrowserWindow, BrowserView, ipcMain, shell, session, dialog, nativeImage, net } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { scoreIssues } = require('./scoring.cjs');

const APP_NAME = 'PixelClam';
const USER_DATA_DIR_NAME = 'UXChecker-2';

let mainWindow = null;
let activeAudit = null;
let browserContext = null;
let browserView = null;
let browserViewVisible = false;
let reportView = null;
let reportViewVisible = false;
let activeAuditLogPath = '';
let activeAuditMirrorLogPath = '';
let activeAuditStartedAt = 0;

const TOOLBAR_HEIGHT = 114;
const LEFT_NAV_WIDTH = 232;
const BROWSER_PARTITION = 'persist:uxchecker-browser';

app.setName(APP_NAME);
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

function resolveNodeBin() {
  const localNode = path.join(
    __dirname,
    '..',
    '.tools',
    'node-v22.11.0-darwin-arm64',
    'bin',
    'node'
  );
  try {
    require('node:fs').accessSync(localNode);
    return localNode;
  } catch {
    return process.execPath;
  }
}

function inferImageDesignNormalization(sourcePath, imageSize) {
  const width = Number(imageSize?.width || 0);
  const height = Number(imageSize?.height || 0);
  const baseName = path.basename(String(sourcePath || '')).toLowerCase();
  const normalized = {
    enabled: false,
    reason: '',
    originalWidth: width,
    originalHeight: height,
    analysisWidth: width,
    analysisHeight: height,
    scaleX: 1,
    scaleY: 1
  };

  if (!width || !height) return normalized;

  const designNameHint = /@2x|sketch|meaxure|measure|mastergo|figma|artboard|preview|画板|设计稿/.test(baseName);
  const candidateHalfWidth = width / 2;
  const candidateHalfHeight = height / 2;
  const likelyRetinaExport =
    Number.isInteger(candidateHalfWidth) &&
    Number.isInteger(candidateHalfHeight) &&
    candidateHalfWidth >= 1280 &&
    candidateHalfWidth <= 1920 &&
    candidateHalfHeight >= 720 &&
    candidateHalfHeight <= 1200;

  if (!(designNameHint && likelyRetinaExport)) {
    return normalized;
  }

  normalized.enabled = true;
  normalized.reason = `检测到设计稿导出信号（文件名含设计稿特征，且尺寸 ${width}×${height} 疑似 ${candidateHalfWidth}×${candidateHalfHeight} 的 2x 导出）`;
  normalized.analysisWidth = Math.round(candidateHalfWidth);
  normalized.analysisHeight = Math.round(candidateHalfHeight);
  normalized.scaleX = width / normalized.analysisWidth;
  normalized.scaleY = height / normalized.analysisHeight;
  return normalized;
}

function scaleImagePreviewMarkers(markers, normalization) {
  if (!normalization?.enabled || !Array.isArray(markers)) return Array.isArray(markers) ? markers : [];
  return markers.map((marker) => {
    const center = marker?.center || {};
    const x = Number(center.x);
    const y = Number(center.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return marker;
    return {
      ...marker,
      center: {
        x: Math.round(x * normalization.scaleX),
        y: Math.round(y * normalization.scaleY)
      }
    };
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#f5f5f5',
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    ensureBrowserView();
    layoutBrowserView();
  });
  mainWindow.webContents.once('did-finish-load', () => {
    ensureBrowserView();
    layoutBrowserView();
  });
  mainWindow.on('resize', layoutBrowserView);
  mainWindow.on('closed', () => {
    mainWindow = null;
    browserView = null;
    reportView = null;
  });
}

function ensureBrowserView() {
  if (!mainWindow || browserView) return browserView;
  browserView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: false,
      partition: BROWSER_PARTITION
    }
  });
  browserView.webContents.on('did-start-loading', () => {
    send('browser:state', { loading: true, url: browserView.webContents.getURL() });
  });
  browserView.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    send('browser:state', {
      loading: false,
      url: validatedURL,
      errorCode,
      errorDescription,
      message: `页面加载失败：${errorDescription || errorCode}`
    });
  });
  browserView.webContents.on('did-stop-loading', () => {
    send('browser:state', {
      loading: false,
      url: browserView.webContents.getURL(),
      title: browserView.webContents.getTitle(),
      canGoBack: browserView.webContents.canGoBack(),
      canGoForward: browserView.webContents.canGoForward()
    });
  });
  browserView.webContents.on('did-navigate', (_event, url) => {
    send('browser:state', { url, canGoBack: browserView.webContents.canGoBack(), canGoForward: browserView.webContents.canGoForward() });
  });
  browserView.webContents.on('did-navigate-in-page', (_event, url) => {
    send('browser:state', { url, canGoBack: browserView.webContents.canGoBack(), canGoForward: browserView.webContents.canGoForward() });
  });
  browserView.webContents.setWindowOpenHandler(({ url }) => {
    browserView.webContents.loadURL(url);
    return { action: 'deny' };
  });
  return browserView;
}

function ensureReportView() {
  if (!mainWindow || reportView) return reportView;
  reportView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: false
    }
  });
  reportView.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  reportView.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    send('report:state', {
      visible: reportViewVisible,
      url: validatedURL,
      errorCode,
      errorDescription,
      message: `报告加载失败：${errorDescription || errorCode}`
    });
  });
  reportView.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level < 2) return;
    appendAuditLog('report:console', { level, message, line, sourceId });
  });
  return reportView;
}

function layoutBrowserView() {
  if (!mainWindow) return;
  const [width, height] = mainWindow.getContentSize();
  if (browserView && browserViewVisible) {
    browserView.setBounds({
      x: LEFT_NAV_WIDTH,
      y: TOOLBAR_HEIGHT,
      width: Math.max(320, width - LEFT_NAV_WIDTH),
      height: Math.max(240, height - TOOLBAR_HEIGHT)
    });
    browserView.setAutoResize({ width: true, height: true });
  }
  if (reportView && reportViewVisible) {
    reportView.setBounds({
      x: LEFT_NAV_WIDTH,
      y: TOOLBAR_HEIGHT,
      width: Math.max(320, width - LEFT_NAV_WIDTH),
      height: Math.max(240, height - TOOLBAR_HEIGHT)
    });
    reportView.setAutoResize({ width: true, height: true });
  }
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function closeReportView() {
  if (!mainWindow || !reportView || !reportViewVisible) return;
  mainWindow.removeBrowserView(reportView);
  reportViewVisible = false;
  send('report:state', { visible: false });
  if (browserView && browserViewVisible && typeof mainWindow.setTopBrowserView === 'function') {
    mainWindow.setTopBrowserView(browserView);
  }
}

function setBrowserViewVisible(visible) {
  if (!mainWindow) return;
  const view = ensureBrowserView();
  const nextVisible = Boolean(visible);
  if (nextVisible && !browserViewVisible) {
    mainWindow.addBrowserView(view);
    browserViewVisible = true;
  } else if (!nextVisible && browserViewVisible) {
    mainWindow.removeBrowserView(view);
    browserViewVisible = false;
  }
  if (nextVisible) {
    closeReportView();
    if (typeof mainWindow.setTopBrowserView === 'function') mainWindow.setTopBrowserView(view);
  }
  layoutBrowserView();
}

function send(channel, payload) {
  if (channel === 'audit:event' || channel === 'audit:status' || channel === 'audit:log') {
    appendAuditLog(channel, payload);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function startAuditLog(runDir, metadata = {}) {
  activeAuditLogPath = path.join(runDir, 'audit.log');
  activeAuditMirrorLogPath = '';
  activeAuditStartedAt = Date.now();
  const record = {
    timestamp: new Date().toISOString(),
    elapsedMs: 0,
    channel: 'audit:lifecycle',
    phase: 'started',
    message: '检测日志已创建',
    ...metadata
  };
  fs.appendFileSync(activeAuditLogPath, `${JSON.stringify(record)}\n`, 'utf8');
  return activeAuditLogPath;
}

function appendAuditLog(channel, payload = {}) {
  if (!activeAuditLogPath) return;
  const record = {
    timestamp: new Date().toISOString(),
    elapsedMs: activeAuditStartedAt ? Date.now() - activeAuditStartedAt : 0,
    channel,
    ...payload
  };
  const line = `${JSON.stringify(record)}\n`;
  try {
    fs.appendFileSync(activeAuditLogPath, line, 'utf8');
  } catch {
    // Logging must never interrupt an audit.
  }
  if (activeAuditMirrorLogPath) {
    try {
      fs.appendFileSync(activeAuditMirrorLogPath, line, 'utf8');
    } catch {
      // The run log remains the primary diagnostic record.
    }
  }
}

async function moveAuditLogTo(evidenceDir) {
  if (!activeAuditLogPath) return '';
  const targetPath = path.join(evidenceDir, 'audit.log');
  if (path.resolve(activeAuditLogPath) !== path.resolve(targetPath)) {
    await fsp.copyFile(activeAuditLogPath, targetPath);
    activeAuditMirrorLogPath = targetPath;
  }
  return targetPath;
}

function finishAuditLog(status, message = '') {
  appendAuditLog('audit:lifecycle', {
    phase: status,
    message: message || (status === 'completed' ? '检测完成' : '检测结束')
  });
  activeAuditLogPath = '';
  activeAuditMirrorLogPath = '';
  activeAuditStartedAt = 0;
}

const { normalizeAuditUrl: normalizeUrl } = require('../src/main/url-utils.cjs');

function sameAuditUrl(actual, expected) {
  try {
    const left = new URL(String(actual || ''));
    const right = new URL(String(expected || ''));
    const normalizePath = (value) => value.length > 1 ? value.replace(/\/+$/, '') : value;
    return left.protocol === right.protocol &&
      left.hostname === right.hostname &&
      left.port === right.port &&
      normalizePath(left.pathname) === normalizePath(right.pathname) &&
      left.search === right.search &&
      left.hash === right.hash;
  } catch {
    return String(actual || '') === String(expected || '');
  }
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

function modelConfigPath() {
  return path.join(userDataRoot(), 'config', 'model-config.json');
}

function userDataRoot() {
  // Keep the legacy directory name so upgrades retain the user's local key, Skills and reports.
  return process.env.UXCHECKER_HOME || path.join(app.getPath('documents'), USER_DATA_DIR_NAME);
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

function browserProfileRoot() {
  return path.join(app.getPath('userData'), 'browser-profile');
}

function bundledTestAssetsRoot() {
  if (!app.isPackaged) return '';
  return path.join(process.resourcesPath, 'test-bootstrap');
}

async function copyDirectoryEntriesIfMissing(sourceDir, targetDir, renameEntry = (name) => name) {
  if (!fs.existsSync(sourceDir)) return;
  await fsp.mkdir(targetDir, { recursive: true });
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const targetName = renameEntry(entry.name);
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, targetName);
    if (fs.existsSync(targetPath)) continue;
    await fsp.cp(sourcePath, targetPath, { recursive: true, force: false, errorOnExist: false });
  }
}

async function syncDirectoryEntries(sourceDir, targetDir, renameEntry = (name) => name) {
  if (!fs.existsSync(sourceDir)) return;
  await fsp.mkdir(targetDir, { recursive: true });
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const targetName = renameEntry(entry.name);
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, targetName);
    await fsp.cp(sourcePath, targetPath, { recursive: true, force: true });
  }
}

async function quarantineLegacySkills() {
  const skillsRoot = userSkillsRoot();
  const legacyDir = path.join(skillsRoot, 'Paletx-UX-audit');
  if (!fs.existsSync(legacyDir)) return;

  const disabledRoot = path.join(userDataRoot(), '.disabled-skills');
  await fsp.mkdir(disabledRoot, { recursive: true });
  const targetDir = path.join(disabledRoot, `Paletx-UX-audit-${Date.now()}`);
  await fsp.rename(legacyDir, targetDir);
}

async function initializeUserWorkspace() {
  const root = userDataRoot();
  const configDir = path.join(root, 'config');
  await Promise.all([
    fsp.mkdir(userSkillsRoot(), { recursive: true }),
    fsp.mkdir(userReportsRoot(), { recursive: true }),
    fsp.mkdir(userRunsRoot(), { recursive: true }),
    fsp.mkdir(configDir, { recursive: true }),
    fsp.mkdir(browserProfileRoot(), { recursive: true })
  ]);

  const bundledExample = path.join(__dirname, '..', 'config', 'model-config.example.json');
  const userExample = path.join(configDir, 'model-config.example.json');
  if (!fs.existsSync(userExample) && fs.existsSync(bundledExample)) {
    await fsp.copyFile(bundledExample, userExample);
  }
  if (!fs.existsSync(modelConfigPath()) && fs.existsSync(bundledExample)) {
    await fsp.copyFile(bundledExample, modelConfigPath());
  }

  const testAssets = bundledTestAssetsRoot();
  if (testAssets && fs.existsSync(testAssets)) {
    await syncDirectoryEntries(path.join(testAssets, 'skills'), userSkillsRoot());
    const bundledModelConfig = path.join(testAssets, 'config', 'model-config.json');
    if (!fs.existsSync(modelConfigPath()) && fs.existsSync(bundledModelConfig)) {
      await fsp.copyFile(bundledModelConfig, modelConfigPath());
    }
  }

  await quarantineLegacySkills();
}

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function readSkillManifest(skillDir) {
  const manifestPath = path.join(skillDir, 'skill.json');
  let manifest = {};
  try {
    manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  } catch {
    // Legacy skills can still be discovered from SKILL.md.
  }

  const entry = String(manifest.entry || 'SKILL.md');
  const reportRenderer = String(manifest.reportRenderer || 'scripts/render-interactive-report.mjs');
  const entryPath = path.resolve(skillDir, entry);
  const rendererPath = path.resolve(skillDir, reportRenderer);
  if (!isPathInside(skillDir, entryPath) || !isPathInside(skillDir, rendererPath)) {
    throw new Error(`Skill 路径越界：${path.basename(skillDir)}`);
  }
  if (!fs.existsSync(entryPath) || !fs.existsSync(rendererPath)) {
    throw new Error(`Skill 缺少入口或报告渲染器：${path.basename(skillDir)}`);
  }

  let fallbackName = path.basename(skillDir);
  let fallbackDescription = '';
  let fallbackVersion = '';
  try {
    const source = await fsp.readFile(entryPath, 'utf8');
    fallbackName = source.match(/^name:\s*(.+)$/m)?.[1]?.trim() || fallbackName;
    fallbackDescription = source.match(/^description:\s*(.+)$/m)?.[1]?.trim() || '';
    fallbackVersion = source.match(/^\s*version:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim() || '';
  } catch {
    // The validated file may still be temporarily unavailable; use folder metadata.
  }

  return {
    id: String(manifest.id || path.basename(skillDir)),
    name: String(manifest.name || fallbackName),
    groupName: String(manifest.groupName || manifest.name || fallbackName),
    visibleSkins: Array.isArray(manifest.visibleSkins) ? manifest.visibleSkins.map((item) => String(item)) : [],
    audit: manifest.audit && typeof manifest.audit === 'object' ? manifest.audit : {},
    version: String(manifest.version || fallbackVersion || '0.0.0'),
    description: String(manifest.description || fallbackDescription),
    entry,
    entryPath,
    reportRenderer,
    rendererPath,
    folderName: path.basename(skillDir),
    path: skillDir
  };
}

async function readSkillSkinEntries(skill) {
  const indexPath = path.join(skill.path, 'standards', 'skins', 'index.json');
  if (!fs.existsSync(indexPath)) return [skill];
  let skinIndex = null;
  try {
    skinIndex = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
  } catch {
    return [skill];
  }
  let skins = Array.isArray(skinIndex?.skins) ? skinIndex.skins.filter((item) => item && item.id && item.name) : [];
  if (skill.visibleSkins?.length) {
    const allowed = new Set(skill.visibleSkins);
    skins = skins.filter((item) => allowed.has(String(item.id)));
  }
  if (!skins.length) return [skill];

  const groupLabel = `${skill.groupName || skill.name}（分组）`;
  const entries = [{
    id: `${skill.id}::group`,
    name: groupLabel,
    description: skill.description,
    groupName: skill.groupName || skill.name,
    entryType: 'group',
    disabled: true,
    baseSkillId: skill.id,
    folderName: skill.folderName,
    path: skill.path,
    sortOrder: 0
  }];

  for (const [index, skin] of skins.entries()) {
    const componentRoots = [
      path.join(skill.path, 'standards', 'component-packs-v3', 'skins', String(skin.id), 'components'),
      path.join(skill.path, 'standards', 'flattened-v2', 'skins', String(skin.id), 'components'),
      path.join(skill.path, 'standards', 'skins', String(skin.id), 'components')
    ];
    const componentRoot = componentRoots.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory());
    const componentCount = componentRoot
      ? (await fsp.readdir(componentRoot)).filter((name) => name.endsWith('.json')).length
      : 0;
    entries.push({
      ...skill,
      id: `${skill.id}::skin::${skin.id}`,
      name: String(skin.name),
      description: skill.description,
      entryType: 'skin',
      skinId: String(skin.id),
      skinName: String(skin.name),
      baseSkillId: skill.id,
      groupName: skill.groupName || skill.name,
      disabled: false,
      componentCount,
      sortOrder: index + 1
    });
  }
  return entries;
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
          delta: item.delta || ''
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

async function maybeRunAiAnalysis({ appRoot, runDir, runtime, audit, skillDir, skillMeta = {} }) {
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
      aiRounds: [],
      aiEnabled: false,
      modelName: '',
      aiStatus: baseStatus
    };
  }
  if (!config.apiKey) {
    send('audit:event', { phase: 'ai:skip', message: 'AI 分析已启用，但未配置 API Key，跳过模型分析' });
    return {
      audit,
      aiAnalysisPath: null,
      aiEvidencePath: null,
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
    send('audit:event', { phase: 'ai:start', message: `调用大模型分析：${config.provider || 'kimi'} / ${config.model}` });
    const stopHeartbeat = startModelHeartbeat(config.timeoutMs);
    let ai;
    try {
      ai = await modelClient.runAiUxAnalysis({
        config,
        runtime,
        audit,
        skillDir,
        skillMeta,
        runDir,
        fetchImpl: electronFetch,
        onProgress: (event) => send('audit:event', event)
      });
    } finally {
      stopHeartbeat();
    }
    const merged = mergeAiAudit(audit, ai.analysis);
    send('audit:event', {
      phase: 'ai:done',
      message: `AI 分析完成：${ai.model || config.model}`,
      aiAnalysisPath: ai.aiAnalysisPath,
      score: merged.audit.score,
      stars: merged.audit.stars
    });
    const roundList = Array.isArray(ai?.analysis?.rounds) ? ai.analysis.rounds : [];
    const roundIssueTotal = roundList.reduce((sum, round) => sum + Number(round?.issueCount || 0), 0);
    const aiStatus = {
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
    };
    return {
      audit: merged.audit,
      aiAnalysisPath: ai.aiAnalysisPath,
      aiEvidencePath: ai.aiEvidencePath,
      auditPlanPath: ai.auditPlanPath || path.join(runDir, 'audit-plan.json'),
      aiRounds: Array.isArray(ai?.analysis?.rounds) ? ai.analysis.rounds : [],
      aiEnabled: true,
      modelName: ai.model || config.model,
      aiStatus
    };
  } catch (error) {
    let auditPlan = null;
    const auditPlanPath = path.join(runDir, 'audit-plan.json');
    try {
      auditPlan = JSON.parse(await fsp.readFile(auditPlanPath, 'utf8'));
      if (Array.isArray(auditPlan.steps)) {
        const current = auditPlan.steps.find((step) => step.status === 'running');
        if (current) current.status = 'failed';
      }
      auditPlan = {
        ...auditPlan,
        status: 'failed',
        failureReason: error?.message || String(error)
      };
      await fsp.writeFile(auditPlanPath, JSON.stringify(auditPlan, null, 2), 'utf8');
    } catch {
      auditPlan = null;
    }
    const aiErrorPath = path.join(runDir, 'ai-error.json');
    await fsp.writeFile(aiErrorPath, JSON.stringify({
      ok: false,
      createdAt: new Date().toISOString(),
      message: error?.message || String(error),
      stack: error?.stack || ''
    }, null, 2), 'utf8');
    send('audit:event', {
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

function electronFetch(url, options) {
  return net.fetch(url, options);
}

function startModelHeartbeat(timeoutMs = 120000) {
  const startedAt = Date.now();
  const timeoutSeconds = Math.round(Number(timeoutMs || 120000) / 1000);
  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    send('audit:event', {
      phase: 'ai:waiting',
      message: `模型正在分析，已等待 ${elapsed} 秒（超时上限 ${timeoutSeconds} 秒）`
    });
  }, 12000);
  return () => clearInterval(timer);
}

async function listSkills() {
  await fsp.mkdir(userSkillsRoot(), { recursive: true });
  const entries = await fsp.readdir(userSkillsRoot(), { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'Paletx-UX-audit') continue;
    const skillDir = path.join(userSkillsRoot(), entry.name);
    try {
      const skill = await readSkillManifest(skillDir);
      const expandedEntries = await readSkillSkinEntries(skill);
      skills.push(...expandedEntries);
    } catch {
      // Invalid or incomplete folders are not shown as installable skills.
    }
  }
  try {
    fs.appendFileSync('/tmp/uxchecker2.log', `[${new Date().toISOString()}] listSkills candidates: ${JSON.stringify(skills.map((item) => ({ id: item.id, name: item.name, entryType: item.entryType, groupName: item.groupName, skinId: item.skinId || '' })))}\n`, 'utf8');
  } catch {}

  return skills.sort((a, b) => {
    const groupCompare = String(a.groupName || a.name).localeCompare(String(b.groupName || b.name), 'zh-CN');
    if (groupCompare !== 0) return groupCompare;
    if (Number.isFinite(Number(a.sortOrder)) || Number.isFinite(Number(b.sortOrder))) {
      const aOrder = a.sortOrder ?? 9999;
      const bOrder = b.sortOrder ?? 9999;
      return Number(aOrder) - Number(bOrder);
    }
    if ((a.entryType || '') !== (b.entryType || '')) {
      if (a.entryType === 'group') return -1;
      if (b.entryType === 'group') return 1;
    }
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
  });
}

async function listReports() {
  await fsp.mkdir(userReportsRoot(), { recursive: true });
  const entries = await fsp.readdir(userReportsRoot(), { withFileTypes: true });
  const reports = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const reportDir = path.join(userReportsRoot(), entry.name);
    const reportPath = path.join(reportDir, 'index.html');
    if (!fs.existsSync(reportPath)) continue;
    const stat = await fsp.stat(reportDir);
    let title = entry.name.replace(/-\d{8}-?\d{6}$/, '');
    let score = null;
    let stars = '';
    try {
      const report = JSON.parse(await fsp.readFile(path.join(reportDir, 'report.json'), 'utf8'));
      title = report.title || report.targetName || title;
      score = Number.isFinite(Number(report.score)) ? Number(report.score) : null;
      stars = report.stars || '';
    } catch {
      // Older reports can still be opened from index.html.
    }
    reports.push({
      id: entry.name,
      title,
      score,
      stars,
      reportPath,
      reportDir,
      createdAt: stat.birthtimeMs || stat.mtimeMs
    });
  }
  return reports.sort((a, b) => b.createdAt - a.createdAt);
}

async function resolveSkillDir(skillId = '') {
  const skills = await listSkills();
  const selectableSkills = skills.filter((item) => !item.disabled && item.entryType !== 'group');
  if (!selectableSkills.length) {
    throw new Error(`请安装验收 Skill：将完整 Skill 文件夹复制到 ${userSkillsRoot()}`);
  }
  const requested = String(skillId || '');
  const skill = requested
    ? selectableSkills.find((item) => item.id === requested || item.folderName === requested || item.baseSkillId === requested)
    : selectableSkills[0];
  if (!skill) throw new Error(`找不到已选择的 Skill：${requested}`);
  return skill;
}

async function renderReport(skill, reportDataPath, reportName, reportDirOverride = null) {
  const appRoot = path.join(__dirname, '..');
  const platformRoot = path.join(appRoot, '..');
  const script = skill.rendererPath;
  const reportDir = reportDirOverride || path.join(userReportsRoot(), `${safeName(reportName)}-${timestamp()}`);
  const outPath = path.join(reportDir, 'index.html');
  const dataOutPath = path.join(reportDir, 'report.json');
  const nodeBin = resolveNodeBin();
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin, [
      script,
      `--data=${reportDataPath}`,
      `--name=${reportName}`,
      `--out=${outPath}`,
      `--data-out=${dataOutPath}`
    ], {
      cwd: platformRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
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
      if (code !== 0) return reject(new Error(stderr || `报告渲染失败，退出码 ${code}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`报告渲染输出无法解析：${stdout}`));
      }
    });
  });
}

async function copyIfExists(sourcePath, targetPath) {
  if (!sourcePath) return null;
  try {
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.copyFile(sourcePath, targetPath);
    return targetPath;
  } catch {
    return null;
  }
}

async function createReportPackage(appRoot, targetName, evidenceFiles, reportKind = 'UX当前页验收报告') {
  const reportName = `${safeName(targetName)}-${reportKind}`;
  const reportDir = path.join(userReportsRoot(), `${reportName}-${timestamp()}`);
  const evidenceDir = path.join(reportDir, 'evidence');
  await fsp.mkdir(evidenceDir, { recursive: true });
  const screenshotExtension = path.extname(evidenceFiles.screenshotPath || '').toLowerCase() || '.png';

  const packaged = {
    screenshotPath: await copyIfExists(evidenceFiles.screenshotPath, path.join(evidenceDir, `screenshot${screenshotExtension}`)),
    runtimePath: await copyIfExists(evidenceFiles.runtimePath, path.join(evidenceDir, 'runtime.json')),
    normalizedEvidencePath: await copyIfExists(evidenceFiles.normalizedEvidencePath, path.join(evidenceDir, 'normalized-evidence.json')),
    safeEvidencePath: await copyIfExists(evidenceFiles.safeEvidencePath, path.join(evidenceDir, 'safe-evidence.json')),
    evidenceSummaryPath: await copyIfExists(evidenceFiles.evidenceSummaryPath, path.join(evidenceDir, 'evidence-summary.json')),
    aiAnalysisPath: await copyIfExists(evidenceFiles.aiAnalysisPath, path.join(evidenceDir, path.basename(evidenceFiles.aiAnalysisPath || 'ai-analysis.json'))),
    aiEvidencePath: await copyIfExists(evidenceFiles.aiEvidencePath, path.join(evidenceDir, 'ai-evidence.json'))
  };

  return { reportName, reportDir, evidenceDir, packaged };
}

async function normalizeEvidence(runDir, runtime) {
  const appRoot = path.join(__dirname, '..');
  const normalizer = await import(pathToFileURL(path.join(appRoot, 'src', 'main', 'evidence-normalizer.mjs')).href);
  const normalizedEvidence = normalizer.normalizeRuntimeEvidence(runtime);
  runtime.normalizedEvidence = normalizedEvidence;
  runtime.normalizedElements = normalizedEvidence.elements;

  const normalizedEvidencePath = path.join(runDir, 'normalized-evidence.json');
  await fsp.writeFile(normalizedEvidencePath, JSON.stringify(normalizedEvidence, null, 2), 'utf8');
  return { normalizedEvidence, normalizedEvidencePath };
}

async function buildSafeEvidenceFile(runDir, runtime) {
  const appRoot = path.join(__dirname, '..');
  const builder = await import(pathToFileURL(path.join(appRoot, 'src', 'main', 'safe-evidence-builder.mjs')).href);
  const safeEvidencePath = path.join(runDir, 'safe-evidence.json');
  const safeEvidence = await builder.writeSafeEvidence(runtime, safeEvidencePath);
  runtime.safeEvidence = safeEvidence;
  return { safeEvidence, safeEvidencePath };
}

async function summarizeEvidence(runDir, runtime, screenshotPath, runtimePath, normalizedEvidencePath, safeEvidencePath) {
  const hintCounts = {};
  const effectiveElements = runtime.normalizedEvidence?.elements || runtime.elements || [];
  for (const element of effectiveElements) {
    for (const hint of element.semanticHints || ['unknown']) {
      hintCounts[hint] = (hintCounts[hint] || 0) + 1;
    }
  }
  const evidenceSummaryPath = path.join(runDir, 'evidence-summary.json');
  await fsp.writeFile(
    evidenceSummaryPath,
    JSON.stringify({
      title: runtime.title,
      url: runtime.url,
      viewport: runtime.viewport,
      screenshot: screenshotPath,
      runtimeJson: runtimePath,
      normalizedEvidenceJson: normalizedEvidencePath,
      safeEvidenceJson: safeEvidencePath,
      rawElementCount: runtime.elements.length,
      effectiveElementCount: effectiveElements.length,
      droppedElementCount: runtime.normalizedEvidence?.droppedElementCount || 0,
      hintCounts,
      typeCounts: runtime.normalizedEvidence?.typeCounts || {},
      regionCounts: runtime.normalizedEvidence?.regionCounts || {},
      regions: runtime.normalizedEvidence?.regions || [],
      relationCounts: {
        horizontalGaps: runtime.normalizedEvidence?.relations?.horizontalGaps?.length || 0,
        verticalGaps: runtime.normalizedEvidence?.relations?.verticalGaps?.length || 0,
        actionGroups: runtime.normalizedEvidence?.relations?.actionGroups?.length || 0
      },
      sampleRelations: {
        horizontalGaps: (runtime.normalizedEvidence?.relations?.horizontalGaps || []).slice(0, 20),
        verticalGaps: (runtime.normalizedEvidence?.relations?.verticalGaps || []).slice(0, 20),
        actionGroups: (runtime.normalizedEvidence?.relations?.actionGroups || []).slice(0, 10)
      },
      sampleElements: effectiveElements.slice(0, 30).map((element) => ({
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
    }, null, 2),
    'utf8'
  );
  return { evidenceSummaryPath, hintCounts };
}

ipcMain.handle('audit:start', async (_event, options) => {
  if (activeAudit) {
    throw new Error('已有检测任务正在运行');
  }

  const runnerPath = path.join(__dirname, '..', 'src', 'main', 'audit-runner.mjs');
  const nodeBin = resolveNodeBin();
  const args = [
    runnerPath,
    `--url=${options.url}`,
    `--viewport=${options.viewport || '1440x900'}`,
    `--waitUntil=${options.waitUntil || 'domcontentloaded'}`,
    `--manualLogin=${options.manualLogin ? 'true' : 'false'}`,
    `--manualWaitMs=${options.manualWaitMs || 90000}`
  ];

  if (options.modelProvider) args.push(`--modelProvider=${options.modelProvider}`);
  if (options.modelBaseUrl) args.push(`--modelBaseUrl=${options.modelBaseUrl}`);
  if (options.modelName) args.push(`--modelName=${options.modelName}`);
  if (options.apiKey) args.push(`--apiKey=${options.apiKey}`);

  const child = spawn(nodeBin, args, {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      UXCHECKER_NODE_PATH: nodeBin,
      UXCHECKER_HOME: userDataRoot(),
      UXCHECKER_BROWSER_PROFILE: browserProfileRoot()
    }
  });

  activeAudit = child;
  send('audit:status', { phase: 'started', message: '检测任务已启动' });

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        send('audit:event', event);
      } catch {
        send('audit:log', { stream: 'stdout', message: line });
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    send('audit:log', { stream: 'stderr', message: chunk.toString() });
  });

  child.on('close', (code) => {
    activeAudit = null;
    send('audit:status', {
      phase: code === 0 ? 'completed' : 'failed',
      message: code === 0 ? '检测完成' : `检测失败，退出码 ${code}`
    });
  });

  return { ok: true };
});

ipcMain.handle('browser:open', async (_event, options) => {
  const url = normalizeUrl(options.url);
  if (!url) throw new Error('请输入地址');

  const appRoot = path.join(__dirname, '..');
  const { chromium } = await import('playwright');
  if (!browserContext) {
      browserContext = await chromium.launchPersistentContext(browserProfileRoot(), {
      headless: false,
      viewport: (() => {
        const match = String(options.viewport || '1440x900').match(/^(\d+)x(\d+)$/);
        return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: 1440, height: 900 };
      })(),
      ignoreHTTPSErrors: true
    });
    browserContext.on('close', () => {
      browserContext = null;
      send('audit:status', { phase: 'browser:closed', message: '浏览器已关闭' });
    });
  }
  const page = browserContext.pages()[0] || await browserContext.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  send('audit:status', { phase: 'browser:opened', message: `浏览器已打开：${url}` });
  return { ok: true, url };
});

ipcMain.handle('browser:auditCurrent', async () => {
  if (!browserContext) throw new Error('请先打开浏览器，并进入要检测的页面');

  const appRoot = path.join(__dirname, '..');
  const runId = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const runDir = path.join(userRunsRoot(), runId);
  await fsp.mkdir(runDir, { recursive: true });
  const auditLogPath = startAuditLog(runDir, { mode: 'dom', source: 'playwright-browser' });

  send('audit:event', { phase: 'run:init', message: `检测当前浏览器页面；日志：${auditLogPath}`, runDir, auditLogPath });
  const pages = browserContext.pages();
  const page = pages[pages.length - 1];
  if (!page) throw new Error('浏览器中没有可检测页面');

  const runtimePath = path.join(runDir, 'runtime.json');
  const screenshotPath = path.join(runDir, 'screenshot.png');
  const collector = await import(pathToFileURL(path.join(appRoot, 'src', 'main', 'collector.mjs')).href);
  const runtime = await collector.collectPageEvidence(page, {
    out: runtimePath,
    screenshot: screenshotPath,
    requestedUrl: page.url(),
    manualLogin: true
  });
  send('audit:event', { phase: 'collector:done', message: `当前页采集完成：${runtime.elements.length} 个元素`, runtimePath, screenshot: screenshotPath });

  const { normalizedEvidence, normalizedEvidencePath } = await normalizeEvidence(runDir, runtime);
  send('audit:event', {
    phase: 'evidence:normalized',
    message: `证据归一化完成：原始 ${normalizedEvidence.rawElementCount} 个，有效 ${normalizedEvidence.effectiveElementCount} 个`,
    normalizedEvidencePath,
    typeCounts: normalizedEvidence.typeCounts,
    regionCounts: normalizedEvidence.regionCounts
  });
  const { safeEvidence, safeEvidencePath } = await buildSafeEvidenceFile(runDir, runtime);
  send('audit:event', {
    phase: 'evidence:safe',
    message: `安全证据生成完成：${safeEvidence.elements.length} 个脱敏视觉对象，可用于模型分析`,
    safeEvidencePath
  });

  const ruleEngine = await import(pathToFileURL(path.join(appRoot, 'src', 'main', 'rule-engine.mjs')).href);
  let audit = ruleEngine.auditRuntime(runtime);
  const { evidenceSummaryPath, hintCounts } = await summarizeEvidence(runDir, runtime, screenshotPath, runtimePath, normalizedEvidencePath, safeEvidencePath);
  send('audit:event', { phase: 'evidence:summary', message: `证据摘要完成：${normalizedEvidence.effectiveElementCount} 个有效对象`, runtimePath, evidenceSummaryPath, normalizedEvidencePath, safeEvidencePath, hintCounts });

  const targetName = runtime.title || new URL(runtime.url).hostname;
  const skill = await resolveSkillDir();
  const reportPackage = await createReportPackage(appRoot, targetName, {
    screenshotPath,
    runtimePath,
    normalizedEvidencePath,
    safeEvidencePath,
    evidenceSummaryPath
  });
  const packaged = reportPackage.packaged;
  await moveAuditLogTo(reportPackage.evidenceDir);
  const aiResult = await maybeRunAiAnalysis({
    appRoot,
    runDir: reportPackage.evidenceDir,
    runtime,
    audit,
    skillDir: skill.path,
    skillMeta: {
      id: skill.id,
      name: skill.name,
      baseSkillId: skill.baseSkillId || skill.id,
      skinId: skill.skinId || '',
      skinName: skill.skinName || skill.name || ''
    }
  });
  audit = aiResult.audit;
  const sourcedIssues = withRuleIssueSource(audit.issues);
  const reportData = {
    title: `${targetName || '当前页面'} UX 当前页验收报告`,
    targetName,
    targetImage: packaged.screenshotPath || screenshotPath,
    mode: `检查方式：Playwright 当前页采集；视口 ${runtime.viewport?.width}×${runtime.viewport?.height}，DPR ${runtime.viewport?.devicePixelRatio}`,
    standard: '标准：公司 UI 规范 / PaletX Pro；不按品牌、产品名、页面标题或 logo 文案扣分，仅按本页实际出现元素评分',
    score: audit.score,
    stars: audit.stars,
    summary: audit.summary || `已采集当前浏览器页面 ${runtime.elements.length} 个可见候选元素，归一化后得到 ${normalizedEvidence.effectiveElementCount} 个有效验收对象。报告基于当前页实际出现控件评分。`,
    metrics: [
      { label: '总分', value: String(audit.score) },
      { label: '星级', value: audit.stars },
      { label: '有效对象', value: String(normalizedEvidence.effectiveElementCount) },
      { label: '原始候选', value: String(runtime.elements.length) },
      { label: '视口', value: `${runtime.viewport?.width}×${runtime.viewport?.height}` },
      ...issueSourceMetrics(sourcedIssues),
      ...aiStatusMetrics(aiResult.aiStatus)
    ],
    viewport: runtime.viewport || null,
    issues: sourcedIssues,
    dimensions: audit.dimensions,
    components: audit.components,
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
      '当前页检测基于用户已打开并操作到的页面，不重新跳转 URL。',
      'MVP 当前采集默认态页面，hover/focus/active/disabled/loading 的自动遍历将在后续版本增强。',
      '本次不以品牌、产品名、页面标题或 logo 文案作为扣分依据，只按视觉 token 和组件表现验收。'
    ].concat(aiStatusLimitations(aiResult.aiStatus)),
    rawEvidence: {
      runtimeJson: packaged.runtimePath || runtimePath,
      evidenceSummary: packaged.evidenceSummaryPath || evidenceSummaryPath,
      normalizedEvidence: packaged.normalizedEvidencePath || normalizedEvidencePath,
      safeEvidence: packaged.safeEvidencePath || safeEvidencePath,
      aiAnalysis: packaged.aiAnalysisPath || aiResult.aiAnalysisPath,
      aiEvidence: packaged.aiEvidencePath || aiResult.aiEvidencePath,
      auditPlan: packaged.auditPlanPath || aiResult.auditPlanPath || null,
      requestedUrl: runtime.requestedUrl,
      finalUrl: runtime.url,
      originalRunDir: runDir
    }
  };
  const reportDataPath = path.join(reportPackage.evidenceDir, 'report-data.json');
  await fsp.writeFile(reportDataPath, JSON.stringify(reportData, null, 2), 'utf8');

  send('audit:event', { phase: 'report:render', message: '生成 HTML 验收报告' });
  const renderResult = await renderReport(skill, reportDataPath, reportPackage.reportName, reportPackage.reportDir);
  send('audit:event', {
    phase: 'run:done',
    message: '检测完成',
    score: audit.score,
    stars: audit.stars,
    reportPath: renderResult.out,
    reportDir: renderResult.reportDir,
    skillDir: skill.path,
    skillId: skill.id,
    skillVersion: skill.version,
    screenshot: packaged.screenshotPath || screenshotPath,
    runtimePath: packaged.runtimePath || runtimePath,
    evidenceSummaryPath: packaged.evidenceSummaryPath || evidenceSummaryPath,
    normalizedEvidencePath: packaged.normalizedEvidencePath || normalizedEvidencePath,
    safeEvidencePath: packaged.safeEvidencePath || safeEvidencePath,
    aiEvidencePath: packaged.aiEvidencePath || aiResult.aiEvidencePath,
    aiAnalysisPath: packaged.aiAnalysisPath || aiResult.aiAnalysisPath,
    aiStatus: aiResult.aiStatus || null
  });
  send('audit:status', { phase: 'completed', message: '检测完成' });
  finishAuditLog('completed', '检测完成，报告已生成');
  return { ok: true, reportPath: renderResult.out };
});

ipcMain.handle('audit:stop', async () => {
  if (!activeAudit) return { ok: true, stopped: false };
  activeAudit.kill('SIGTERM');
  activeAudit = null;
  send('audit:status', { phase: 'stopped', message: '检测已停止' });
  return { ok: true, stopped: true };
});

ipcMain.handle('audit:clientError', async (_event, message) => {
  const text = String(message || '检测失败');
  appendAuditLog('audit:client', {
    phase: 'failed',
    message: text
  });
  finishAuditLog('failed', text);
  return { ok: true };
});

ipcMain.handle('workspace:listSkills', async () => {
  return { ok: true, skills: await listSkills(), skillsDir: userSkillsRoot() };
});

ipcMain.handle('workspace:listReports', async () => {
  return { ok: true, reports: await listReports(), reportsDir: userReportsRoot() };
});

function cleanIssueList(componentResult, screenshotPath) {
  return (componentResult.results || []).flatMap((component) =>
    (component.issues || []).map((issue) => ({
      issueSource: 'ai',
      issueSourceLabel: '大模型识别',
      severity: issue.severity === 'high' ? 'severe' : issue.severity === 'medium' ? 'medium' : 'minor',
      severityLabel: issue.severity === 'high' ? '严重' : issue.severity === 'medium' ? '中等' : '轻微',
      title: `${component.componentName}不符合当前皮肤 ${componentResult.componentFamily} 规范`,
      description: issue.problem,
      actual: issue.problem,
      standard: `当前皮肤 ${componentResult.componentFamily} 组件规范`,
      location: issue.location,
      delta: `匹配 ${component.matchedVariant}，置信度 ${component.confidence}`,
      previewImage: screenshotPath,
      previewMarkers: []
    }))
  );
}

function cleanLayoutIssueList(layoutResult, screenshotPath) {
  return (layoutResult?.issues || []).map((issue) => ({
    issueSource: 'ai',
    issueSourceLabel: '大模型识别',
    severity: issue.severity === 'high' ? 'severe' : issue.severity === 'medium' ? 'medium' : 'minor',
    severityLabel: issue.severity === 'high' ? '严重' : issue.severity === 'medium' ? '中等' : '轻微',
    title: `页面布局不符合规范（${issue.ruleId}）`,
    description: issue.problem,
    actual: issue.problem,
    standard: '当前 Skill 公共布局规范',
    location: issue.location,
    delta: `布局类型 ${layoutResult.pagePattern}，置信度 ${issue.confidence}`,
    previewImage: screenshotPath,
    previewMarkers: []
  }));
}

async function resolveCleanComponentStandard(skill, componentFamily) {
  const skinId = String(skill.skinId || 'default');
  const roots = [
    path.join(skill.path, 'standards', 'component-packs-v3', 'skins', skinId, 'components'),
    path.join(skill.path, 'standards', 'flattened-v2', 'skins', skinId, 'components'),
    path.join(skill.path, 'standards', 'skins', skinId, 'components')
  ];
  for (const root of roots) {
    for (const extension of ['json', 'md']) {
      const candidate = path.join(root, `${componentFamily}.${extension}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`当前皮肤 ${skinId} 缺少 ${componentFamily} 组件规范`);
}

async function discoverCleanComponentStandards(skill) {
  const skinId = String(skill.skinId || 'default');
  const roots = [
    path.join(skill.path, 'standards', 'component-packs-v3', 'skins', skinId, 'components'),
    path.join(skill.path, 'standards', 'flattened-v2', 'skins', skinId, 'components'),
    path.join(skill.path, 'standards', 'skins', skinId, 'components')
  ];
  const root = roots.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory());
  if (!root) throw new Error(`当前皮肤 ${skinId} 没有 components 规范目录`);
  const files = (await fsp.readdir(root))
    .filter((name) => name.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b, 'en'));
  if (!files.length) throw new Error(`当前皮肤 ${skinId} 没有可验收的组件规范`);
  const standards = [];
  for (const fileName of files) {
    const standardPath = path.join(root, fileName);
    let standard;
    try {
      standard = JSON.parse(await fsp.readFile(standardPath, 'utf8'));
    } catch (error) {
      throw new Error(`组件规范 JSON 无效：${standardPath}；${error?.message || error}`);
    }
    const componentFamily = path.basename(fileName, '.json');
    const errors = [];
    if (!standard || typeof standard !== 'object' || Array.isArray(standard)) errors.push('根节点必须是 JSON 对象');
    if (standard?.selfContained !== true) errors.push('selfContained 必须为 true');
    if (!standard?.component?.id) errors.push('缺少 component.id');
    if (standard?.component?.id && String(standard.component.id) !== componentFamily) errors.push(`component.id 必须与文件名一致（${componentFamily}）`);
    if (!standard?.component?.displayName && !standard?.component?.name) errors.push('缺少 component.displayName 或 component.name');
    if (!standard?.skin?.id) errors.push('缺少 skin.id');
    if (standard?.skin?.id && String(standard.skin.id) !== skinId) errors.push(`skin.id 必须等于当前皮肤 ${skinId}`);
    if (!standard?.rules && !standard?.componentStructure && !standard?.skinStyle && !standard?.sourceResolvedStyle) errors.push('缺少可执行规则（rules/componentStructure/skinStyle/sourceResolvedStyle 至少一项）');
    if (errors.length) throw new Error(`组件规范结构不合格：${standardPath}；${errors.join('；')}`);
    standards.push({
      componentFamily,
      standardPath
    });
  }
  return standards;
}

async function runCleanElectronAudit({ mode, skillId, imagePath = '', webContents = null, expectedUrl = '', auditStrategy = 'deep' }) {
  const appRoot = path.join(__dirname, '..');
  const skill = await resolveSkillDir(skillId);
  const standards = await discoverCleanComponentStandards(skill);
  const componentFamilies = standards.map((item) => item.componentFamily);
  const modelClient = await import(pathToFileURL(path.join(appRoot, 'src', 'main', 'model-client.mjs')).href);
  const componentAudit = await import(pathToFileURL(path.join(appRoot, 'src', 'main', 'component-audit.mjs')).href);
  const fastComponentAudit = await import(pathToFileURL(path.join(appRoot, 'src', 'main', 'fast-component-audit.mjs')).href);
  const layoutAudit = await import(pathToFileURL(path.join(appRoot, 'src', 'main', 'layout-audit.mjs')).href);
  const layoutStandardCandidates = [
    path.join(skill.path, 'standards', 'layout', 'layout-audit-pack-v1.json'),
    path.join(skill.path, 'standards', 'paletx-core', 'layout', 'layout-audit-pack-v1.json')
  ];
  const layoutStandardPath = layoutStandardCandidates.find((candidate) => fs.existsSync(candidate));
  if (!layoutStandardPath) throw new Error(`缺少自包含布局规范，应提供：${layoutStandardCandidates[0]}`);
  const config = await modelClient.loadModelConfig(modelConfigPath());
  if (!config.enabled || !config.apiKey) throw new Error('请先启用并配置模型 API Key');
  const runId = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const runDir = path.join(userRunsRoot(), runId);
  await fsp.mkdir(runDir, { recursive: true });
  const auditLogPath = startAuditLog(runDir, { mode, source: mode === 'image' ? 'uploaded-image' : 'embedded-browser-clean' });
  const auditPlanPath = path.join(runDir, 'audit-plan.json');
  await fsp.writeFile(auditPlanPath, JSON.stringify({
    schemaVersion: 'page-audit-plan-v3',
    mode,
    auditStrategy,
    skinId: skill.skinId || 'default',
    createdAt: new Date().toISOString(),
    steps: [
      { auditFamily: 'layout', standardPath: layoutStandardPath, status: 'pending' },
      ...standards.map((item) => ({ auditFamily: 'component', ...item, status: 'pending' }))
    ]
  }, null, 2), 'utf8');
  send('audit:event', {
    phase: 'run:init',
    message: auditStrategy === 'fast'
      ? `开始快速验收：完整页面证据 + 全部组件规范动态分包；日志：${auditLogPath}`
      : `开始深度验收：组件盘点后逐组件独立验收；日志：${auditLogPath}`,
    runDir,
    runId,
    auditLogPath,
    auditStrategy
  });

  let evidencePath;
  let screenshotPath;
  let targetName;
  let viewport = null;
  let originResult = null;
  if (mode === 'image') {
    const sourcePath = path.resolve(String(imagePath || ''));
    if (!fs.existsSync(sourcePath)) throw new Error('请选择有效的页面截图');
    const extension = path.extname(sourcePath).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) throw new Error('图片模式仅支持 PNG、JPG、JPEG 和 WebP');
    screenshotPath = path.join(runDir, `screenshot${extension}`);
    await fsp.copyFile(sourcePath, screenshotPath);
    evidencePath = screenshotPath;
    targetName = path.basename(sourcePath, extension);
    const size = nativeImage.createFromPath(sourcePath).getSize();
    viewport = { width: size.width, height: size.height, devicePixelRatio: null };
  } else {
    if (!webContents) throw new Error('没有可采集的当前页面');
    const freezer = await import(pathToFileURL(path.join(appRoot, 'src', 'main', 'electron-dom-snapshot.mjs')).href);
    send('audit:event', { phase: 'snapshot:start', message: '冻结登录后的完整运行态 DOM' });
    const snapshot = await freezer.freezeWebContents(webContents, { outDir: runDir });
    if (expectedUrl && !sameAuditUrl(snapshot.url, expectedUrl)) {
      throw new Error(`采集页面校验失败：要求 ${expectedUrl}，实际冻结 ${snapshot.url}。已停止模型请求，请重新进入待测页面。`);
    }
    evidencePath = snapshot.modelSnapshotPath;
    screenshotPath = snapshot.screenshotPath;
    targetName = snapshot.title || '当前页面';
    viewport = snapshot.viewport;
    send('audit:event', {
      phase: 'snapshot:done',
      message: '完整 DOM 与模型可读 DOM 已冻结，模型无需重新登录',
      snapshotPath: snapshot.snapshotPath,
      modelSnapshotPath: evidencePath
    });
  }

  let layoutRun = null;
  let layoutFailure = null;
  send('audit:event', {
    phase: 'ai:round:start',
    roundId: 'layout',
    checkedItems: ['layout'],
    message: `发送一份独立的“${skill.groupName || skill.name}”公共布局规范给模型；不要求匹配固定参考页`,
    standardPath: layoutStandardPath
  });
  try {
    const output = await layoutAudit.auditLayout({
      mode,
      evidencePath,
      standardPath: layoutStandardPath,
      config,
      artifactDir: runDir,
      fetchImpl: electronFetch,
      onProgress: (event) => send('audit:event', event)
    });
    const resultPath = path.join(runDir, 'layout-result.json');
    await fsp.writeFile(resultPath, JSON.stringify(output.result, null, 2), 'utf8');
    layoutRun = { standardPath: layoutStandardPath, resultPath, ...output };
    const plan = JSON.parse(await fsp.readFile(auditPlanPath, 'utf8'));
    const step = plan.steps.find((item) => item.auditFamily === 'layout');
    step.status = 'completed';
    step.issueCount = output.result.issues.length;
    step.resultPath = resultPath;
    await fsp.writeFile(auditPlanPath, JSON.stringify(plan, null, 2), 'utf8');
    send('audit:event', { phase: 'ai:round:done', roundId: 'layout', checkedItems: ['layout'], issueCount: output.result.issues.length, message: `布局验收完成，发现 ${output.result.issues.length} 条问题` });
  } catch (error) {
    layoutFailure = error?.message || String(error);
    const plan = JSON.parse(await fsp.readFile(auditPlanPath, 'utf8'));
    const step = plan.steps.find((item) => item.auditFamily === 'layout');
    step.status = 'failed';
    step.error = layoutFailure;
    await fsp.writeFile(auditPlanPath, JSON.stringify(plan, null, 2), 'utf8');
    send('audit:event', { phase: 'ai:round:failed', roundId: 'layout', checkedItems: ['layout'], message: `布局验收失败，继续组件队列：${layoutFailure}` });
  }

  let auditStandards = standards;
  if (mode === 'dom' && auditStrategy !== 'fast') {
    const originClassifier = await import(pathToFileURL(path.join(appRoot, 'src', 'main', 'dom-component-origin.mjs')).href);
    send('audit:event', { phase: 'origin:start', message: '盘点当前页面实际出现的组件族' });
    originResult = await originClassifier.classifyDomComponentOrigins({
      evidencePath,
      standards,
      config,
      artifactDir: runDir,
      fetchImpl: electronFetch,
      onProgress: (event) => send('audit:event', event)
    });
    const skipped = new Set(originResult.skippedAbsentFamilies);
    auditStandards = standards.filter((item) => !skipped.has(item.componentFamily));
    const plan = JSON.parse(await fsp.readFile(auditPlanPath, 'utf8'));
    for (const step of plan.steps) {
      if (originResult.skippedAbsentFamilies.includes(step.componentFamily)) {
        step.status = 'skipped-not-present';
        step.reason = 'DOM来源盘点高置信确认当前页面未出现该组件族，不发起组件验收调用';
      }
    }
    plan.originInventoryPath = originResult.resultPath;
    await fsp.writeFile(auditPlanPath, JSON.stringify(plan, null, 2), 'utf8');
    send('audit:event', {
      phase: 'origin:done',
      message: `组件盘点完成：页面未出现 ${originResult.skippedAbsentFamilies.length} 个；继续验收实际出现或无法排除的组件族`,
      skippedAbsentFamilies: originResult.skippedAbsentFamilies
    });
  }

  let componentRuns = [];
  const failedRuns = [];
  let fastRun = null;
  if (auditStrategy === 'fast') {
    if (mode !== 'dom') throw new Error('快速模式第一期仅支持 DOM，请切换到深度模式执行图片验收');
    fastRun = await fastComponentAudit.auditComponentsFast({
      mode,
      evidencePath,
      standards,
      config,
      fastMode: skill.audit?.fastMode || {},
      artifactDir: runDir,
      fetchImpl: electronFetch,
      onProgress: (event) => send('audit:event', event)
    });
    componentRuns = fastRun.componentRuns;
    failedRuns.push(...fastRun.failures.map((failure) => ({
      componentFamily: failure.components.join(','),
      standardPath: '',
      message: failure.error
    })));
    const plan = JSON.parse(await fsp.readFile(auditPlanPath, 'utf8'));
    for (const step of plan.steps.filter((item) => item.auditFamily === 'component')) {
      const run = componentRuns.find((item) => item.componentFamily === step.componentFamily);
      if (run) {
        step.status = 'completed-fast';
        step.issueCount = (run.result.results || []).reduce((sum, item) => sum + (item.issues?.length || 0), 0);
      } else {
        step.status = 'failed';
        step.error = '快速模式未获得该组件的可确认结果';
      }
    }
    plan.fastMode = {
      completedBatches: fastRun.completedBatches.length,
      failedBatches: fastRun.failures.length,
      fixedPrefixTokens: fastRun.packing.fixedPrefixTokens,
      contextWindowTokens: fastRun.packing.budget.contextWindowTokens,
      standardBudget: fastRun.packing.standardBudget
    };
    await fsp.writeFile(auditPlanPath, JSON.stringify(plan, null, 2), 'utf8');
  } else for (const standardEntry of auditStandards) {
    const { componentFamily, standardPath } = standardEntry;
    const roundId = `component-${componentFamily}`;
    send('audit:event', {
      phase: 'ai:round:start',
      roundId,
      checkedItems: [componentFamily],
      message: `只发送 ${skill.skinName || skill.skinId}/${componentFamily} 规范给模型`,
      componentFamily,
      standardPath
    });
    try {
      const output = await componentAudit.auditComponent({
        mode,
        evidencePath,
        standardPath,
        componentFamily,
        config,
        artifactDir: runDir,
        fetchImpl: electronFetch,
        onProgress: (event) => send('audit:event', event)
      });
      const resultPath = path.join(runDir, `${componentFamily}-result.json`);
      await fsp.writeFile(resultPath, JSON.stringify(output.result, null, 2), 'utf8');
      const issueCount = (output.result.results || []).reduce((sum, item) => sum + (item.issues?.length || 0), 0);
      componentRuns.push({ componentFamily, standardPath, resultPath, ...output });
      const plan = JSON.parse(await fsp.readFile(auditPlanPath, 'utf8'));
      const step = plan.steps.find((item) => item.componentFamily === componentFamily);
      if (step) {
        step.status = 'completed';
        step.issueCount = issueCount;
        step.resultPath = resultPath;
      }
      await fsp.writeFile(auditPlanPath, JSON.stringify(plan, null, 2), 'utf8');
      send('audit:event', {
        phase: 'ai:round:done',
        roundId,
        checkedItems: [componentFamily],
        issueCount,
        summary: output.result.summary,
        message: `${componentFamily} 验收完成，发现 ${issueCount} 条问题`
      });
    } catch (error) {
      const failure = { componentFamily, standardPath, message: error?.message || String(error) };
      failedRuns.push(failure);
      const failurePath = path.join(runDir, `${componentFamily}-error.json`);
      await fsp.writeFile(failurePath, JSON.stringify(failure, null, 2), 'utf8');
      const plan = JSON.parse(await fsp.readFile(auditPlanPath, 'utf8'));
      const step = plan.steps.find((item) => item.componentFamily === componentFamily);
      if (step) {
        step.status = 'failed';
        step.error = failure.message;
        step.errorPath = failurePath;
      }
      await fsp.writeFile(auditPlanPath, JSON.stringify(plan, null, 2), 'utf8');
      send('audit:event', {
        phase: 'ai:round:failed',
        roundId,
        checkedItems: [componentFamily],
        message: `${componentFamily} 验收失败，继续下一组件：${failure.message}`
      });
    }
  }
  if (!componentRuns.length && auditStandards.length > 0) throw new Error(`全部 ${auditStandards.length} 个待验组件验收失败，请查看 audit-plan.json`);
  const merged = componentAudit.mergeComponentResults({
    mode,
    skin: skill.skinId || 'default',
    source: { evidencePath },
    componentRuns,
    skippedAbsentFamilies: originResult?.skippedAbsentFamilies || [],
    originRun: originResult,
    layoutRun
  });
  const mergedResultPath = path.join(runDir, 'report.json');
  await fsp.writeFile(mergedResultPath, JSON.stringify(merged, null, 2), 'utf8');
  const issues = [
    ...cleanLayoutIssueList(layoutRun?.result, screenshotPath),
    ...componentRuns.flatMap((run) => cleanIssueList(run.result, screenshotPath))
  ];
  const scoring = scoreIssues(issues);
  const { score } = scoring;
  const stars = score >= 95 ? '★★★★★' : score >= 85 ? '★★★★☆' : score >= 70 ? '★★★☆☆' : score >= 60 ? '★★☆☆☆' : '★☆☆☆☆';
  const reportPackage = await createReportPackage(appRoot, targetName, { screenshotPath }, mode === 'image' ? 'UX图片验收报告' : 'UX当前页验收报告');
  await copyIfExists(evidencePath, path.join(reportPackage.evidenceDir, mode === 'image' ? path.basename(evidencePath) : 'dom-evidence.html'));
  if (mode === 'dom') {
    await copyIfExists(path.join(runDir, 'dom-snapshot.html'), path.join(reportPackage.evidenceDir, 'dom-snapshot.html'));
    await copyIfExists(path.join(runDir, 'snapshot-manifest.json'), path.join(reportPackage.evidenceDir, 'snapshot-manifest.json'));
    await copyIfExists(path.join(runDir, 'dom-component-inventory.json'), path.join(reportPackage.evidenceDir, 'dom-component-inventory.json'));
  }
  for (const run of componentRuns) {
    if (run.resultPath) await copyIfExists(run.resultPath, path.join(reportPackage.evidenceDir, `${run.componentFamily}-result.json`));
    if (run.requestManifestPath) await copyIfExists(run.requestManifestPath, path.join(reportPackage.evidenceDir, `${run.componentFamily}-request-manifest.json`));
    if (run.rawResponsePath) await copyIfExists(run.rawResponsePath, path.join(reportPackage.evidenceDir, `${run.componentFamily}-raw-response.json`));
  }
  for (const batch of fastRun?.completedBatches || []) {
    if (batch.manifestPath) await copyIfExists(batch.manifestPath, path.join(reportPackage.evidenceDir, path.basename(batch.manifestPath)));
    if (batch.rawResponsePath) await copyIfExists(batch.rawResponsePath, path.join(reportPackage.evidenceDir, path.basename(batch.rawResponsePath)));
  }
  if (layoutRun) {
    await copyIfExists(layoutRun.resultPath, path.join(reportPackage.evidenceDir, 'layout-result.json'));
    await copyIfExists(layoutRun.requestManifestPath, path.join(reportPackage.evidenceDir, 'layout-request-manifest.json'));
    await copyIfExists(layoutRun.rawResponsePath, path.join(reportPackage.evidenceDir, 'layout-raw-response.json'));
  }
  await copyIfExists(mergedResultPath, path.join(reportPackage.evidenceDir, 'merged-report.json'));
  await copyIfExists(auditPlanPath, path.join(reportPackage.evidenceDir, 'audit-plan.json'));
  await moveAuditLogTo(reportPackage.evidenceDir);
  const reportData = {
    title: `${targetName} UX ${mode === 'image' ? '图片' : 'DOM'}验收报告`,
    targetName,
    targetImage: reportPackage.packaged.screenshotPath || screenshotPath,
    mode: mode === 'image'
      ? '检查方式：页面图片 + 单组件规范'
      : auditStrategy === 'fast'
        ? '检查方式：登录后冻结 DOM + 全量组件规范动态分包（快速模式）'
        : '检查方式：登录后冻结 DOM + 单组件规范（深度模式）',
    standard: `公共布局规范 + 皮肤：${skill.skinName || skill.skinId || skill.name}；组件：${componentFamilies.join('、')}`,
    score,
    stars,
    summary: `公共布局验收 ${layoutRun ? '完成' : '失败'}；${auditStrategy === 'fast' ? `快速模式动态执行 ${fastRun?.completedBatches?.length || 0} 批` : `页面未出现 ${originResult?.skippedAbsentFamilies?.length || 0} 个`}；当前 Skill 共加载 ${standards.length} 个组件规范，组件完成 ${componentRuns.length} 个、失败 ${failedRuns.length} 个，共发现 ${issues.length} 条明确问题。`,
    metrics: [
      { label: '总分', value: String(score) },
      { label: '问题数', value: String(issues.length) },
      { label: '严重 / 中等 / 轻微', value: `${scoring.counts.severe} / ${scoring.counts.medium} / ${scoring.counts.minor}` },
      { label: '质量扣分', value: `-${scoring.penalty}` },
      { label: '证据模式', value: mode === 'image' ? '图片' : 'DOM' },
      { label: '检测策略', value: auditStrategy === 'fast' ? '快速模式' : '深度模式' },
      { label: '组件族', value: String(componentFamilies.length) }
      ,{ label: '布局问题', value: String(layoutRun?.result?.issues?.length || 0) }
      ,{ label: '页面未出现', value: String(originResult?.skippedAbsentFamilies?.length || 0) }
      ,{ label: '执行失败', value: String(failedRuns.length) }
      ,...(auditStrategy === 'fast' ? [{ label: '快速批次', value: String(fastRun?.completedBatches?.length || 0) }] : [])
    ],
    viewport,
    issues,
    dimensions: layoutRun ? [{
      name: '页面布局',
      score: scoreIssues(cleanLayoutIssueList(layoutRun.result, screenshotPath)).score,
      summary: layoutRun.result.summary
    }] : [],
    components: componentRuns.flatMap((run) => (run.result.results || []).map((item) => ({
      name: `${run.componentFamily} / ${item.componentName}`,
      status: item.issues?.length ? '不符合' : '通过',
      actual: item.issues?.map((issue) => issue.problem).join('；') || '未发现明确问题',
      standard: `${item.matchedVariant} / ${run.componentFamily}`,
      suggestion: item.issues?.length ? '按当前皮肤组件规范修正' : '无需处理'
    }))),
    skill: { id: skill.id, name: skill.name, version: skill.version },
    model: { enabled: true, name: componentRuns.map((run) => run.model).filter(Boolean).join(' / ') },
    limitations: [
      ...(mode === 'image' ? ['图片模式无法读取 DOM 与精确 computed style。'] : []),
      ...(layoutFailure ? [`布局验收轮次失败：${layoutFailure}`] : []),
      ...(failedRuns.length ? [`${failedRuns.length} 个组件轮次失败，详见 audit-plan.json。`] : [])
    ],
    rawEvidence: {
      evidence: evidencePath,
      mergedResult: mergedResultPath,
      componentResults: componentRuns.map((run) => ({
        componentFamily: run.componentFamily,
        resultPath: run.resultPath,
        standardPath: run.standardPath
      })),
      failedComponents: failedRuns
      ,layoutResult: layoutRun?.resultPath || null
      ,layoutFailure
      ,skippedAbsentFamilies: originResult?.skippedAbsentFamilies || []
      ,auditStrategy
      ,fastMode: fastRun ? {
        completedBatches: fastRun.completedBatches.length,
        failures: fastRun.failures,
        packing: fastRun.packing
      } : null
    }
  };
  const reportDataPath = path.join(reportPackage.evidenceDir, 'report-data.json');
  await fsp.writeFile(reportDataPath, JSON.stringify(reportData, null, 2), 'utf8');
  const renderResult = await renderReport(skill, reportDataPath, reportPackage.reportName, reportPackage.reportDir);
  send('audit:event', { phase: 'run:done', message: '布局与组件验收完成', reportPath: renderResult.out, score, stars });
  send('audit:status', { phase: 'completed', message: '检测完成' });
  finishAuditLog('completed', '干净主链检测完成');
  return { ok: true, reportPath: renderResult.out };
}

ipcMain.handle('image:select', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择页面截图',
    properties: ['openFile'],
    filters: [
      { name: '页面截图', extensions: ['png', 'jpg', 'jpeg', 'webp'] }
    ]
  });
  if (result.canceled || !result.filePaths[0]) return { ok: true, canceled: true };
  const imagePath = result.filePaths[0];
  const image = nativeImage.createFromPath(imagePath);
  if (image.isEmpty()) throw new Error('图片无法读取，请选择有效的 PNG、JPG 或 WebP 文件');
  const size = image.getSize();
  return {
    ok: true,
    path: imagePath,
    name: path.basename(imagePath),
    width: size.width,
    height: size.height
  };
});

ipcMain.handle('image:audit', async (_event, options = {}) => {
  return runCleanElectronAudit({ mode: 'image', skillId: options.skillId, imagePath: options.imagePath, auditStrategy: 'deep' });
  /* legacy implementation retained temporarily for migration comparison */
  const sourcePath = path.resolve(String(options.imagePath || ''));
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('请选择有效的页面截图');
  const extension = path.extname(sourcePath).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) {
    throw new Error('图片模式仅支持 PNG、JPG、JPEG 和 WebP');
  }

  const image = nativeImage.createFromPath(sourcePath);
  if (image.isEmpty()) throw new Error('图片无法读取或文件已损坏');
  const imageSize = image.getSize();
  const normalization = inferImageDesignNormalization(sourcePath, imageSize);
  const appRoot = path.join(__dirname, '..');
  const runId = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const runDir = path.join(userRunsRoot(), runId);
  await fsp.mkdir(runDir, { recursive: true });
  const auditLogPath = startAuditLog(runDir, { mode: 'image', source: 'uploaded-image' });

  const targetName = path.basename(sourcePath, extension);
  const screenshotPath = path.join(runDir, `screenshot${extension}`);
  const analysisImagePath = normalization.enabled
    ? path.join(runDir, 'analysis-input.png')
    : screenshotPath;
  const runtimePath = path.join(runDir, 'runtime.json');
  const safeEvidencePath = path.join(runDir, 'safe-evidence.json');
  const evidenceSummaryPath = path.join(runDir, 'evidence-summary.json');
  const runtime = {
    auditMode: 'visual',
    evidenceMode: 'image',
    inputMode: 'image',
    title: targetName,
    requestedUrl: '',
    url: '',
    capturedAt: new Date().toISOString(),
    viewport: {
      width: imageSize.width,
      height: imageSize.height,
      devicePixelRatio: null
    },
    imageNormalization: normalization,
    screenshot: screenshotPath,
    elements: [],
    limitations: [
      '纯截图模式无法读取 DOM、computed style、CSS px 和隐藏交互状态。',
      '尺寸与间距按截图视觉估算，使用 ±2px 容差。'
    ]
  };

  send('audit:event', {
    phase: 'run:init',
    message: `创建图片视觉验收任务；日志：${auditLogPath}`,
    runDir,
    runId,
    auditLogPath,
    pendingTitle: targetName
  });
  await fsp.copyFile(sourcePath, screenshotPath);
  if (normalization.enabled) {
    const resized = image.resize({
      width: normalization.analysisWidth,
      height: normalization.analysisHeight,
      quality: 'best'
    });
    await fsp.writeFile(analysisImagePath, resized.toPNG());
  }
  await fsp.writeFile(runtimePath, JSON.stringify(runtime, null, 2), 'utf8');
  await fsp.writeFile(safeEvidencePath, JSON.stringify({
    evidenceMode: 'image',
    capturedAt: runtime.capturedAt,
    imageNormalization: normalization,
    image: {
      width: imageSize.width,
      height: imageSize.height,
      fileName: path.basename(screenshotPath)
    },
    toleranceCssPx: 2,
    elements: []
  }, null, 2), 'utf8');
  await fsp.writeFile(evidenceSummaryPath, JSON.stringify({
    title: targetName,
    evidenceMode: 'image',
    screenshot: screenshotPath,
    analysisImage: analysisImagePath,
    imageNormalization: normalization,
    runtimeJson: runtimePath,
    safeEvidenceJson: safeEvidencePath,
    imageWidth: imageSize.width,
    imageHeight: imageSize.height,
    toleranceCssPx: 2
  }, null, 2), 'utf8');
  send('audit:event', {
    phase: 'image:loaded',
    message: normalization.enabled
      ? `页面截图已读取：${imageSize.width}×${imageSize.height}；按设计稿代理图 ${normalization.analysisWidth}×${normalization.analysisHeight} 分析，视觉间距容差 ±2px`
      : `页面截图已读取：${imageSize.width}×${imageSize.height}，视觉间距容差 ±2px`
  });

  const skill = await resolveSkillDir(options.skillId);
  const reportPackage = await createReportPackage(appRoot, targetName, {
    screenshotPath,
    runtimePath,
    safeEvidencePath,
    evidenceSummaryPath
  }, 'UX图片验收报告');
  await moveAuditLogTo(reportPackage.evidenceDir);
  send('audit:event', { phase: 'ai:start', message: '调用视觉模型识别页面元素并执行 PaletX 规范验收' });

  const modelClient = await import(pathToFileURL(path.join(appRoot, 'src', 'main', 'model-client.mjs')).href);
  const modelConfig = await modelClient.loadModelConfig(modelConfigPath());
  let aiResult;
  const stopHeartbeat = startModelHeartbeat(modelConfig.timeoutMs);
  try {
    aiResult = await modelClient.runAiImageUxAnalysis({
      config: modelConfig,
      imagePath: normalization.enabled ? analysisImagePath : (reportPackage.packaged.screenshotPath || screenshotPath),
      imageSize: normalization.enabled
        ? { width: normalization.analysisWidth, height: normalization.analysisHeight }
        : imageSize,
      originalImageSize: imageSize,
      imageNormalization: normalization,
      skillDir: skill.path,
      skillMeta: {
        id: skill.id,
        name: skill.name,
        baseSkillId: skill.baseSkillId || skill.id,
        skinId: skill.skinId || '',
        skinName: skill.skinName || skill.name || ''
      },
      runDir: reportPackage.evidenceDir,
      fetchImpl: electronFetch,
      onProgress: (event) => send('audit:event', event)
    });
  } catch (error) {
    const errorPath = path.join(reportPackage.evidenceDir, 'ai-error.json');
    await fsp.writeFile(errorPath, JSON.stringify({
      ok: false,
      evidenceMode: 'image',
      createdAt: new Date().toISOString(),
      message: error?.message || String(error)
    }, null, 2), 'utf8');
    send('audit:event', {
      phase: 'ai:failed',
      message: `图片模型请求失败：${error?.message || String(error)}`,
      aiAnalysisPath: errorPath
    });
    send('audit:status', {
      phase: 'failed',
      message: `图片验收失败：${error?.message || String(error)}`
    });
    finishAuditLog('failed', error?.message || String(error));
    throw error;
  } finally {
    stopHeartbeat();
  }
  send('audit:event', {
    phase: 'ai:done',
    message: `截图视觉验收完成：${aiResult.model}`
  });
  const imageAiStatus = {
    enabled: Boolean(modelConfig.enabled),
    attempted: true,
    success: true,
    fallback: false,
    state: 'success',
    provider: aiResult.provider || modelConfig.provider || 'kimi',
    model: aiResult.model || modelConfig.model || '',
    mode: 'single',
    roundsStarted: 1,
    roundsCompleted: 1,
    totalRounds: 1,
    message: `图片模式 AI 验收完成：${aiResult.model || modelConfig.model || modelConfig.provider || 'kimi'}`
  };

  const analysis = aiResult.analysis || {};
  const score = Math.max(0, Math.min(100, Math.round(Number(analysis.score) || 0)));
  const stars = analysis.stars || (
    score >= 95 ? '★★★★★' : score >= 85 ? '★★★★☆' : score >= 70 ? '★★★☆☆' : score >= 60 ? '★★☆☆☆' : '★☆☆☆☆'
  );
  const issues = Array.isArray(analysis.issues) ? analysis.issues.map((issue) => ({
    issueSource: issue?.issueSource || 'ai',
    issueSourceLabel: issue?.issueSourceLabel || '大模型识别',
    ...issue,
    previewImage: issue?.previewImage || (reportPackage.packaged.screenshotPath || screenshotPath),
    previewMarkers: scaleImagePreviewMarkers(
      Array.isArray(issue?.previewMarkers) ? issue.previewMarkers : [],
      normalization
    )
  })) : [];
  const reportData = {
    title: `${targetName} UX 图片验收报告`,
    targetName,
    targetImage: reportPackage.packaged.screenshotPath || screenshotPath,
    mode: normalization.enabled
      ? `检查方式：上传截图视觉验收；原图 ${imageSize.width}×${imageSize.height}；按代理图 ${normalization.analysisWidth}×${normalization.analysisHeight} 检测；间距与尺寸允许 ±2px 估算容差`
      : `检查方式：上传截图视觉验收；图片 ${imageSize.width}×${imageSize.height}；间距与尺寸允许 ±2px 估算容差`,
    standard: '标准：公司 UI 规范 / PaletX Pro；仅检查截图中实际出现的视觉元素，不因缺少某类组件扣分',
    score,
    stars,
    summary: analysis.summary || '已完成页面截图视觉验收。',
    metrics: [
      { label: '总分', value: String(score) },
      { label: '星级', value: stars },
      { label: '证据模式', value: '图片' },
      ...(normalization.enabled ? [{ label: '分析基准', value: `${normalization.analysisWidth}×${normalization.analysisHeight}` }] : []),
      { label: '视觉容差', value: '±2px' },
      { label: '图片尺寸', value: `${imageSize.width}×${imageSize.height}` },
      ...issueSourceMetrics(issues),
      ...aiStatusMetrics(imageAiStatus)
    ],
    viewport: {
      width: imageSize.width,
      height: imageSize.height,
      devicePixelRatio: null
    },
    issues,
    dimensions: Array.isArray(analysis.dimensions) ? analysis.dimensions : [],
    components: Array.isArray(analysis.components) ? analysis.components : [],
    limitations: [
      '本次为纯截图视觉模式，尺寸和间距使用 ±2px 估算容差。',
      '无法直接验证 DOM、computed style、真实 CSS px、hover、focus、active、disabled、loading 和 aria 状态。',
      '若无法确认截图 DPR，不把 image px 直接等同于 CSS px。',
      ...aiStatusLimitations(imageAiStatus),
      ...(Array.isArray(analysis.limitations) ? analysis.limitations : [])
    ],
    skill: {
      id: skill.id,
      name: skill.name,
      version: skill.version
    },
    model: {
      enabled: true,
      provider: aiResult.provider,
      name: aiResult.model
    },
    aiStatus: imageAiStatus,
    aiRounds: [
      {
        passId: 'image-visual-pass',
        roundId: 'image-visual-pass',
        roundTitle: '图片视觉验收',
        checkedItems: ['视觉截图模式', '组件样式', '布局间距', '皮肤色值'],
        summary: analysis.summary || '',
        issueCount: Array.isArray(issues) ? issues.length : 0
      }
    ],
    rawEvidence: {
      runtimeJson: reportPackage.packaged.runtimePath || runtimePath,
      evidenceSummary: reportPackage.packaged.evidenceSummaryPath || evidenceSummaryPath,
      safeEvidence: reportPackage.packaged.safeEvidencePath || safeEvidencePath,
      aiAnalysis: aiResult.aiAnalysisPath,
      aiEvidence: aiResult.aiEvidencePath,
      originalRunDir: runDir
    }
  };
  const reportDataPath = path.join(reportPackage.evidenceDir, 'report-data.json');
  await fsp.writeFile(reportDataPath, JSON.stringify(reportData, null, 2), 'utf8');

  send('audit:event', { phase: 'report:render', message: '生成图片模式 HTML 验收报告' });
  const renderResult = await renderReport(skill, reportDataPath, reportPackage.reportName, reportPackage.reportDir);
  send('audit:event', {
    phase: 'run:done',
    message: '图片验收完成',
    score,
    stars,
    reportPath: renderResult.out,
    reportDir: renderResult.reportDir,
    skillDir: skill.path,
    skillId: skill.id,
    skillVersion: skill.version,
    screenshot: reportPackage.packaged.screenshotPath || screenshotPath,
    runtimePath: reportPackage.packaged.runtimePath || runtimePath,
    evidenceSummaryPath: reportPackage.packaged.evidenceSummaryPath || evidenceSummaryPath,
    safeEvidencePath: reportPackage.packaged.safeEvidencePath || safeEvidencePath,
    aiEvidencePath: aiResult.aiEvidencePath,
    aiAnalysisPath: aiResult.aiAnalysisPath,
    aiStatus: imageAiStatus
  });
  send('audit:status', { phase: 'completed', message: '图片验收完成' });
  finishAuditLog('completed', '图片验收完成，报告已生成');
  return { ok: true, reportPath: renderResult.out };
});

ipcMain.handle('embedded:setVisible', async (_event, visible) => {
  setBrowserViewVisible(visible);
  return { ok: true, visible: browserViewVisible };
});

ipcMain.handle('file:open', async (_event, filePath) => {
  if (!filePath) return { ok: false };
  await shell.openPath(filePath);
  return { ok: true };
});

ipcMain.handle('report:openInApp', async (_event, filePath) => {
  if (!filePath) throw new Error('没有可打开的报告');
  const view = ensureReportView();
  if (!reportViewVisible) {
    mainWindow.addBrowserView(view);
    reportViewVisible = true;
  }
  layoutBrowserView();
  if (typeof mainWindow.setTopBrowserView === 'function') {
    mainWindow.setTopBrowserView(view);
  }
  await view.webContents.loadFile(filePath);
  const rendered = await view.webContents.executeJavaScript(`(() => ({
    issueDataCount: (() => { try { return JSON.parse(document.querySelector('#report-data')?.textContent || '{}').issues?.length || 0; } catch { return -1; } })(),
    issueCardCount: document.querySelectorAll('#issueList .issue-card').length,
    componentCardCount: document.querySelectorAll('#componentGrid .component-card').length,
    bodyTextLength: document.body?.innerText?.length || 0
  }))()`);
  if (rendered.issueDataCount > 0 && rendered.issueCardCount === 0) {
    const message = `报告数据包含 ${rendered.issueDataCount} 条问题，但页面未渲染问题卡片`;
    appendAuditLog('report:render-error', { message, filePath, rendered });
    send('report:state', { visible: true, path: filePath, message });
  }
  send('report:state', { visible: true, path: filePath, title: view.webContents.getTitle() });
  return { ok: true };
});

ipcMain.handle('report:closeInApp', async () => {
  closeReportView();
  return { ok: true };
});

ipcMain.handle('report:openExternal', async (_event, filePath) => {
  if (!filePath) return { ok: false };
  await shell.openPath(filePath);
  return { ok: true };
});

ipcMain.handle('report:reveal', async (_event, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, message: '报告文件不存在' };
  shell.showItemInFolder(filePath);
  return { ok: true };
});

ipcMain.handle('folder:open', async (_event, folderPath) => {
  if (!folderPath) return { ok: false };
  await shell.openPath(folderPath);
  return { ok: true };
});

ipcMain.handle('model:loadConfig', async () => {
  const appRoot = path.join(__dirname, '..');
  const modelClient = await import(pathToFileURL(path.join(appRoot, 'src', 'main', 'model-client.mjs')).href);
  return modelClient.loadModelConfig(modelConfigPath());
});

ipcMain.handle('model:saveConfig', async (_event, config) => {
  const appRoot = path.join(__dirname, '..');
  const modelClient = await import(pathToFileURL(path.join(appRoot, 'src', 'main', 'model-client.mjs')).href);
  const current = await modelClient.loadModelConfig(modelConfigPath());
  const saved = await modelClient.saveModelConfig(modelConfigPath(), { ...current, ...(config || {}) });
  return { ok: true, config: saved };
});

ipcMain.handle('model:testConfig', async (_event, config) => {
  const appRoot = path.join(__dirname, '..');
  const modelClient = await import(pathToFileURL(path.join(appRoot, 'src', 'main', 'model-client.mjs')).href);
  return modelClient.testModelConfig({
    ...(config || await modelClient.loadModelConfig(modelConfigPath())),
    fetchImpl: electronFetch
  });
});

ipcMain.handle('model:openConfigFolder', async () => {
  const configDir = path.dirname(modelConfigPath());
  await fsp.mkdir(configDir, { recursive: true });
  const error = await shell.openPath(configDir);
  return error ? { ok: false, message: error } : { ok: true, path: configDir };
});

app.on('second-instance', () => {
  focusMainWindow();
});

if (gotSingleInstanceLock) {
  app.whenReady().then(async () => {
    await initializeUserWorkspace();
    createWindow();
  }).catch((error) => {
    console.error('PixelClam 初始化失败', error);
    app.quit();
  });
}

app.whenReady().then(() => {
  const browserSession = session.fromPartition(BROWSER_PARTITION);
  browserSession.setCertificateVerifyProc((_request, callback) => {
    callback(0);
  });
  app.on('certificate-error', (event, _webContents, _url, _error, _certificate, callback) => {
    event.preventDefault();
    callback(true);
  });
});

ipcMain.handle('embedded:navigate', async (_event, options) => {
  const view = ensureBrowserView();
  setBrowserViewVisible(true);
  closeReportView();
  layoutBrowserView();
  const url = normalizeUrl(options.url);
  await view.webContents.loadURL(url);
  return { ok: true, url };
});

ipcMain.handle('embedded:back', async () => {
  closeReportView();
  if (browserView?.webContents.canGoBack()) browserView.webContents.goBack();
  return { ok: true };
});

ipcMain.handle('embedded:forward', async () => {
  closeReportView();
  if (browserView?.webContents.canGoForward()) browserView.webContents.goForward();
  return { ok: true };
});

ipcMain.handle('embedded:reload', async () => {
  closeReportView();
  browserView?.webContents.reload();
  return { ok: true };
});

ipcMain.handle('embedded:auditCurrent', async (_event, options = {}) => {
  const auditView = ensureBrowserView();
  const requestedUrl = options.requestedUrl ? normalizeUrl(options.requestedUrl) : '';
  const currentUrl = auditView.webContents.getURL();
  if (requestedUrl && !sameAuditUrl(currentUrl, requestedUrl)) {
    send('audit:status', {
      phase: 'navigation:sync',
      message: '地址栏与实际页面不一致，正在重新打开待测地址'
    });
    await auditView.webContents.loadURL(requestedUrl);
  }
  const loadedUrl = auditView.webContents.getURL();
  if (requestedUrl && !sameAuditUrl(loadedUrl, requestedUrl)) {
    throw new Error(`待测页面未正确加载：要求 ${requestedUrl}，实际 ${loadedUrl || '空白页'}`);
  }
  return runCleanElectronAudit({
    mode: 'dom',
    skillId: options.skillId,
    auditStrategy: options.auditStrategy === 'fast' ? 'fast' : 'deep',
    webContents: auditView.webContents,
    expectedUrl: requestedUrl || loadedUrl
  });
  /* legacy implementation retained temporarily for migration comparison */
  closeReportView();
  const view = ensureBrowserView();
  if (!view.webContents.getURL()) throw new Error('请先打开一个页面');

  const appRoot = path.join(__dirname, '..');
  const runId = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const runDir = path.join(userRunsRoot(), runId);
  await fsp.mkdir(runDir, { recursive: true });
  const auditLogPath = startAuditLog(runDir, { mode: 'dom', source: 'embedded-browser' });

  send('audit:event', {
    phase: 'run:init',
    message: `锁定当前内嵌浏览器页面并采集；日志：${auditLogPath}`,
    runDir,
    runId,
    auditLogPath,
    pendingTitle: view.webContents.getTitle() || '当前页面检测'
  });
  const runtimePath = path.join(runDir, 'runtime.json');
  const screenshotPath = path.join(runDir, 'screenshot.png');
  const collector = await import(pathToFileURL(path.join(appRoot, 'src', 'main', 'electron-collector.mjs')).href);
  const runtime = await collector.collectWebContentsEvidence(view.webContents, {
    out: runtimePath,
    screenshot: screenshotPath,
    requestedUrl: view.webContents.getURL(),
    frameTimeoutMs: 60000,
    onProgress: (event) => {
      send('audit:event', event);
    }
  });
  send('audit:event', { phase: 'collector:done', message: `内嵌浏览器当前页采集完成：${runtime.elements.length} 个元素`, runtimePath, screenshot: screenshotPath });

  const { normalizedEvidence, normalizedEvidencePath } = await normalizeEvidence(runDir, runtime);
  send('audit:event', {
    phase: 'evidence:normalized',
    message: `证据归一化完成：原始 ${normalizedEvidence.rawElementCount} 个，有效 ${normalizedEvidence.effectiveElementCount} 个`,
    normalizedEvidencePath,
    typeCounts: normalizedEvidence.typeCounts,
    regionCounts: normalizedEvidence.regionCounts
  });
  const { safeEvidence, safeEvidencePath } = await buildSafeEvidenceFile(runDir, runtime);
  send('audit:event', {
    phase: 'evidence:safe',
    message: `安全证据生成完成：${safeEvidence.elements.length} 个脱敏视觉对象，可用于模型分析`,
    safeEvidencePath
  });

  const ruleEngine = await import(pathToFileURL(path.join(appRoot, 'src', 'main', 'rule-engine.mjs')).href);
  let audit = ruleEngine.auditRuntime(runtime);
  const { evidenceSummaryPath, hintCounts } = await summarizeEvidence(runDir, runtime, screenshotPath, runtimePath, normalizedEvidencePath, safeEvidencePath);
  send('audit:event', { phase: 'evidence:summary', message: `证据摘要完成：${normalizedEvidence.effectiveElementCount} 个有效对象`, runtimePath, evidenceSummaryPath, normalizedEvidencePath, safeEvidencePath, hintCounts });

  const targetName = runtime.title || new URL(runtime.url).hostname;
  const skill = await resolveSkillDir(options.skillId);
  const reportPackage = await createReportPackage(appRoot, targetName, {
    screenshotPath,
    runtimePath,
    normalizedEvidencePath,
    safeEvidencePath,
    evidenceSummaryPath
  });
  const packaged = reportPackage.packaged;
  await moveAuditLogTo(reportPackage.evidenceDir);
  const aiResult = await maybeRunAiAnalysis({
    appRoot,
    runDir: reportPackage.evidenceDir,
    runtime,
    audit,
    skillDir: skill.path,
    skillMeta: {
      id: skill.id,
      name: skill.name,
      baseSkillId: skill.baseSkillId || skill.id,
      skinId: skill.skinId || '',
      skinName: skill.skinName || skill.name || ''
    }
  });
  audit = aiResult.audit;
  send('audit:event', { phase: 'issue-preview:start', message: '生成问题定位截图' });
  const previewBuilder = await import(pathToFileURL(path.join(appRoot, 'src', 'main', 'runtime-issue-previews.mjs')).href);
  audit.issues = await previewBuilder.generateIssuePreviewScreenshots(
    view.webContents,
    audit.issues,
    path.join(reportPackage.reportDir, 'assets', 'issues'),
    {
      sharedPreviewImage: packaged.screenshotPath || screenshotPath,
      viewport: runtime.viewport,
      onProgress: (event) => send('audit:event', event)
    }
  );
  setBrowserViewVisible(false);
  const reportData = {
    title: `${targetName || '当前页面'} UX 当前页验收报告`,
    targetName,
    targetImage: packaged.screenshotPath || screenshotPath,
    mode: `检查方式：Electron 内嵌浏览器当前页采集；视口 ${runtime.viewport?.width}×${runtime.viewport?.height}，DPR ${runtime.viewport?.devicePixelRatio}`,
    standard: '标准：公司 UI 规范 / PaletX Pro；不按品牌、产品名、页面标题或 logo 文案扣分，仅按本页实际出现元素评分',
    score: audit.score,
    stars: audit.stars,
    summary: audit.summary || `已采集内嵌浏览器当前页面 ${runtime.elements.length} 个可见候选元素，归一化后得到 ${normalizedEvidence.effectiveElementCount} 个有效验收对象。报告基于当前页实际出现控件评分。`,
    metrics: [
      { label: '总分', value: String(audit.score) },
      { label: '星级', value: audit.stars },
      { label: '有效对象', value: String(normalizedEvidence.effectiveElementCount) },
      { label: '原始候选', value: String(runtime.elements.length) },
      { label: '视口', value: `${runtime.viewport?.width}×${runtime.viewport?.height}` },
      ...issueSourceMetrics(withRuleIssueSource(audit.issues))
    ],
    viewport: runtime.viewport || null,
    issues: withRuleIssueSource(audit.issues),
    dimensions: audit.dimensions,
    components: audit.components,
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
    limitations: [
      '当前页检测基于 PixelClam 内嵌浏览器，不重新跳转 URL。',
      'MVP 当前采集默认态页面，hover/focus/active/disabled/loading 的自动遍历将在后续版本增强。',
      '本次截图为当前可视区域截图；长页面全量截图后续增强。',
      '本次不以品牌、产品名、页面标题或 logo 文案作为扣分依据，只按视觉 token 和组件表现验收。'
    ].concat(aiStatusLimitations(aiResult.aiStatus)),
    rawEvidence: {
      runtimeJson: packaged.runtimePath || runtimePath,
      evidenceSummary: packaged.evidenceSummaryPath || evidenceSummaryPath,
      normalizedEvidence: packaged.normalizedEvidencePath || normalizedEvidencePath,
      safeEvidence: packaged.safeEvidencePath || safeEvidencePath,
      aiAnalysis: packaged.aiAnalysisPath || aiResult.aiAnalysisPath,
      aiEvidence: packaged.aiEvidencePath || aiResult.aiEvidencePath,
      requestedUrl: runtime.requestedUrl,
      finalUrl: runtime.url,
      originalRunDir: runDir
    }
  };
  const reportDataPath = path.join(reportPackage.evidenceDir, 'report-data.json');
  await fsp.writeFile(reportDataPath, JSON.stringify(reportData, null, 2), 'utf8');

  send('audit:event', { phase: 'report:render', message: '生成 HTML 验收报告' });
  const renderResult = await renderReport(skill, reportDataPath, reportPackage.reportName, reportPackage.reportDir);
  send('audit:event', {
    phase: 'run:done',
    message: '检测完成',
    score: audit.score,
    stars: audit.stars,
    reportPath: renderResult.out,
    reportDir: renderResult.reportDir,
    skillDir: skill.path,
    skillId: skill.id,
    skillVersion: skill.version,
    screenshot: packaged.screenshotPath || screenshotPath,
    runtimePath: packaged.runtimePath || runtimePath,
    evidenceSummaryPath: packaged.evidenceSummaryPath || evidenceSummaryPath,
    normalizedEvidencePath: packaged.normalizedEvidencePath || normalizedEvidencePath,
    safeEvidencePath: packaged.safeEvidencePath || safeEvidencePath,
    aiEvidencePath: packaged.aiEvidencePath || aiResult.aiEvidencePath,
    aiAnalysisPath: packaged.aiAnalysisPath || aiResult.aiAnalysisPath,
    aiStatus: aiResult.aiStatus || null
  });
  send('audit:status', { phase: 'completed', message: '检测完成' });
  finishAuditLog('completed', '检测完成，报告已生成');
  return { ok: true, reportPath: renderResult.out };
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
