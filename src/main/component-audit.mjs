import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { callJsonModel } from './model-client.mjs';

export const COMPONENT_RESULT_TEMPLATE = {
  componentFamily: 'string',
  results: [{
    componentName: 'string',
    matchedVariant: 'string|unknown',
    confidence: 'number 0-1',
    issues: [{
      location: 'string',
      problem: '当前XXX，应该XXX；当前XXX，应该XXX',
      severity: 'low|medium|high'
    }]
  }],
  summary: '一句话'
};

export function normalizeComponentResult(value, componentFamily, mode) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    componentFamily: String(source.componentFamily || componentFamily),
    mode,
    results: (Array.isArray(source.results) ? source.results : []).map((item) => ({
      componentName: String(item?.componentName || '未命名组件'),
      matchedVariant: String(item?.matchedVariant || 'unknown'),
      confidence: Math.max(0, Math.min(1, Number(item?.confidence) || 0)),
      issues: (Array.isArray(item?.issues) ? item.issues : []).slice(0, 2).map((issue) => ({
        location: String(issue?.location || ''),
        problem: String(issue?.problem || ''),
        severity: ['low', 'medium', 'high'].includes(issue?.severity) ? issue.severity : 'low'
      })).filter((issue) => issue.location && issue.problem)
    })),
    summary: String(source.summary || '').slice(0, 120)
  };
}

function imageMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  return 'image/png';
}

async function imageDataUrl(filePath) {
  const bytes = await fs.readFile(filePath);
  return `data:${imageMimeType(filePath)};base64,${bytes.toString('base64')}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const DOM_TAGS_BY_FAMILY = {
  button: ['button'],
  input: ['input', 'textarea'],
  select: ['select', 'option'],
  link: ['a'],
  form: ['form'],
  table: ['table', 'thead', 'tbody', 'tr', 'th', 'td'],
  checkbox: ['input'],
  radio: ['input'],
  progress: ['progress']
};

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractComponentDom(domSnapshot, componentFamily, standardObject) {
  const matches = [];
  const seen = new Set();
  const add = (value) => {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    matches.push(text);
  };
  for (const tag of DOM_TAGS_BY_FAMILY[componentFamily] || []) {
    const paired = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    for (const match of domSnapshot.matchAll(paired)) add(match[0]);
    const opening = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
    for (const match of domSnapshot.matchAll(opening)) add(match[0]);
  }
  const aliases = standardObject?.sourceResolvedStyle?.selectorAliases || [];
  const keywords = new Set([componentFamily, ...aliases.flatMap((value) => String(value).match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || [])]);
  for (const keyword of keywords) {
    const opening = new RegExp(`<[^>]+(?:class|id)=["'][^"']*${escapeRegExp(keyword)}[^"']*["'][^>]*>`, 'gi');
    for (const match of domSnapshot.matchAll(opening)) add(match[0]);
  }
  const maxChars = 120000;
  let result = '';
  for (const match of matches) {
    if (result.length + match.length > maxChars) break;
    result += `${match}\n`;
  }
  return { html: result.trim(), matchCount: matches.length, truncated: matches.length > 0 && result.length >= maxChars };
}

function systemPrompt(componentFamily, mode, reusableDomPrefix = false) {
  const locationRule = mode === 'dom'
    ? 'location 格式为“用户可理解的位置，代码位置（CSS selector 或 DOM 路径）”。'
    : 'location 格式为“用户可理解的位置，图片位置（x,y,w,h）”。';
  return [
    '你是 UXChecker 的单组件族还原度验收员。',
    reusableDomPrefix
      ? '每轮只检查最后一条用户消息指定的组件族，忽略其他组件、页面品牌和业务文案。'
      : `本轮只检查 ${componentFamily}，忽略其他组件、页面品牌和业务文案。`,
    mode === 'dom'
      ? '证据来自运行态 DOM 冻结快照；你必须根据本轮组件规范识别实例、变体和适用范围。是否存在原生组件免检等特殊策略，只能服从本轮规范文件中的明确声明，程序不提供任何品牌级默认策略。'
      : '证据是页面图片；你必须自己识别组件实例和变体，无法从图片确认的精确数值不要编造。',
    '只使用本轮提供的这一份皮肤组件规范，不得套用其他皮肤或通用经验覆盖它。',
    '证据不足时不要报问题。每个组件最多保留 2 条最明确的问题。',
    '规范中的 min/minimum 表示下限、max/maximum 表示上限，不得把满足边界的值误报为必须等于边界值。',
    locationRule,
    'problem 使用“当前XXX，应该XXX；当前XXX，应该XXX”的短句。',
    '只输出严格 JSON，不要解释、markdown 或前后缀。'
  ].join('\n');
}

export async function auditComponent(options) {
  const mode = options.mode === 'image' ? 'image' : 'dom';
  const componentFamily = String(options.componentFamily || 'button');
  const standard = await fs.readFile(options.standardPath, 'utf8');
  let userContent;
  let evidenceBytes;
  let evidenceHash;
  if (mode === 'image') {
    const imageBytes = await fs.readFile(options.evidencePath);
    evidenceBytes = imageBytes.length;
    evidenceHash = sha256(imageBytes);
    userContent = [
      {
        type: 'text',
        text: JSON.stringify({
          task: `按照当前皮肤规范验收图片中的 ${componentFamily}`,
          componentFamily,
          standard,
          requiredOutput: COMPONENT_RESULT_TEMPLATE
        })
      },
      { type: 'image_url', image_url: { url: await imageDataUrl(options.evidencePath) } }
    ];
  } else {
    const domSnapshot = await fs.readFile(options.evidencePath, 'utf8');
    evidenceBytes = Buffer.byteLength(domSnapshot, 'utf8');
    evidenceHash = sha256(domSnapshot);
    const standardObject = JSON.parse(standard);
    const componentEvidence = extractComponentDom(domSnapshot, componentFamily, standardObject);
    userContent = JSON.stringify({
      task: `按照当前皮肤规范验收 DOM 中的 ${componentFamily}`,
      componentFamily,
      standard,
      evidenceNote: '以下是从本地完整冻结DOM中按当前组件族筛出的真实节点，保留computed style和data-ux-box；完整DOM已在本地留档并记录哈希。',
      componentDomMatchCount: componentEvidence.matchCount,
      componentDom: componentEvidence.html,
      requiredOutput: COMPONENT_RESULT_TEMPLATE
    });
    options.componentEvidence = componentEvidence;
  }

  const reusableDomPrefix = false;
  const messages = null;
  const response = await callJsonModel({
    config: options.config,
    fetchImpl: options.fetchImpl,
    onProgress: options.onProgress,
    maxTokens: 3200,
    system: systemPrompt(componentFamily, mode),
    userContent,
    messages,
    reasoningEffort: options.reasoningEffort || 'low',
    schemaHint: COMPONENT_RESULT_TEMPLATE
  });
  if (mode === 'dom' && options.componentEvidence?.matchCount > 0 && /未提供\s*DOM|没有\s*DOM|无法识别.*实例/.test(response.responseContent || '')) {
    throw new Error(`${componentFamily} 轮模型忽略了已提供的 ${options.componentEvidence.matchCount} 个 DOM 证据节点，拒绝将其记为 0 问题`);
  }
  let requestManifestPath = null;
  let rawResponsePath = null;
  if (options.artifactDir) {
    await fs.mkdir(options.artifactDir, { recursive: true });
    requestManifestPath = path.join(options.artifactDir, `${componentFamily}-request-manifest.json`);
    rawResponsePath = path.join(options.artifactDir, `${componentFamily}-raw-response.json`);
    await fs.writeFile(requestManifestPath, JSON.stringify({
      createdAt: new Date().toISOString(),
      mode,
      componentFamily,
      evidencePath: options.evidencePath,
      evidenceBytes,
      evidenceSha256: evidenceHash,
      componentEvidenceMatchCount: options.componentEvidence?.matchCount || 0,
      componentEvidenceBytes: Buffer.byteLength(options.componentEvidence?.html || '', 'utf8'),
      standardPath: options.standardPath,
      standardBytes: Buffer.byteLength(standard, 'utf8'),
      standardSha256: sha256(standard),
      model: response.model,
      reuseEvidencePrefix: reusableDomPrefix,
      reasoningEffort: options.reasoningEffort || 'low',
      usage: response.usage
    }, null, 2), 'utf8');
    await fs.writeFile(rawResponsePath, JSON.stringify({
      createdAt: new Date().toISOString(),
      componentFamily,
      model: response.model,
      content: response.responseContent
    }, null, 2), 'utf8');
  }
  return {
    result: normalizeComponentResult(response.parsed, componentFamily, mode),
    model: response.model,
    requestManifestPath,
    rawResponsePath,
    usage: response.usage
  };
}

export function mergeComponentResults({ mode, skin, source, componentRuns, skippedAbsentFamilies = [], originRun = null, layoutRun = null }) {
  const severityCounts = { high: 0, medium: 0, low: 0 };
  let instanceCount = 0;
  for (const run of componentRuns) {
    instanceCount += run.result.results.length;
    for (const component of run.result.results) {
      for (const issue of component.issues) severityCounts[issue.severity] += 1;
    }
  }
  const issueCount = severityCounts.high + severityCounts.medium + severityCounts.low;
  const layoutSeverityCounts = { high: 0, medium: 0, low: 0 };
  for (const issue of layoutRun?.result?.issues || []) layoutSeverityCounts[issue.severity] += 1;
  const layoutIssueCount = layoutSeverityCounts.high + layoutSeverityCounts.medium + layoutSeverityCounts.low;
  const usage = [originRun?.usage, layoutRun?.usage, ...componentRuns.map((run) => run.usage)].filter(Boolean).reduce((total, item) => ({
    promptTokens: total.promptTokens + Number(item.prompt_tokens || 0),
    cachedTokens: total.cachedTokens + Number(item.cached_tokens || item.prompt_tokens_details?.cached_tokens || 0),
    completionTokens: total.completionTokens + Number(item.completion_tokens || 0),
    totalTokens: total.totalTokens + Number(item.total_tokens || 0)
  }), { promptTokens: 0, cachedTokens: 0, completionTokens: 0, totalTokens: 0 });
  return {
    schemaVersion: 'uxchecker-report-v1',
    generatedAt: new Date().toISOString(),
    mode,
    skin,
    source,
    summary: {
      componentFamilyCount: componentRuns.length,
      skippedAbsentFamilyCount: skippedAbsentFamilies.length,
      componentInstanceCount: instanceCount,
      componentIssueCount: issueCount,
      layoutIssueCount,
      issueCount: issueCount + layoutIssueCount,
      severityCounts: {
        high: severityCounts.high + layoutSeverityCounts.high,
        medium: severityCounts.medium + layoutSeverityCounts.medium,
        low: severityCounts.low + layoutSeverityCounts.low
      },
      usage
    },
    skippedAbsentFamilies,
    originInventory: originRun ? {
      model: originRun.model,
      resultPath: originRun.resultPath,
      usage: originRun.usage
    } : null,
    layout: layoutRun ? {
      standardPath: layoutRun.standardPath,
      model: layoutRun.model,
      ...layoutRun.result
    } : null,
    components: componentRuns.map((run) => ({
      componentFamily: run.componentFamily,
      standardPath: run.standardPath,
      model: run.model,
      ...run.result
    }))
  };
}
