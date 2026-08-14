import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { callJsonModel } from './model-client.mjs';
import { normalizeComponentResult } from './component-audit.mjs';

export const FAST_BATCH_RESULT_TEMPLATE = {
  batch: {
    index: 'number',
    total: 'number',
    domReceived: 'boolean',
    receivedStandardCount: 'number',
    receivedComponents: ['string'],
    lastReceivedComponent: 'string'
  },
  componentResults: [{
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
  }],
  summary: '一句话'
};

const DEFAULT_CONTEXT_WINDOW = 262144;
const DEFAULT_RESERVED_OUTPUT = 6000;
const DEFAULT_SAFETY_RATIO = 0.15;
const MIN_STANDARD_BUDGET = 4096;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function estimateTextTokens(value) {
  const text = String(value || '');
  if (!text) return 0;
  // CSS/HTML/JSON 以 ASCII 为主，中文字段按 UTF-8 更昂贵；bytes/3 是无 tokenizer 时的保守近似。
  return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 3));
}

function fastSystemPrompt(mode) {
  return [
    '你是 PixelClam 快速 UX 还原度验收员。',
    '本轮会提供完整页面证据和多份相互独立的组件规范。必须逐份阅读，但只报告证据充分的明确问题。',
    mode === 'dom'
      ? '证据是运行态冻结 DOM，包含 computed style 和元素位置；请自行理解页面语义并定位相关组件。'
      : '证据是页面截图；无法从图片确认的精确数值不得编造。',
    '每份规范的适用范围、免检策略和比较规则只服从该规范自身声明，不得使用品牌级默认规则。',
    '允许某组件没有实例或没有问题；不要为了覆盖率编造问题。相同根因的同类实例尽量合并。',
    'location 使用“用户可理解的位置，代码位置（CSS selector 或 DOM 路径）”。',
    'problem 使用“当前XXX，应该XXX；当前XXX，应该XXX”的短句。',
    '必须准确填写收件确认字段。只输出严格 JSON，不要 markdown、解释或前后缀。'
  ].join('\n');
}

function fixedPayload({ mode, evidence, outputTemplate }) {
  return {
    task: '根据页面证据，快速验收本批提供的全部独立组件规范；发现多少明确问题就输出多少。',
    evidenceMode: mode,
    pageEvidence: evidence,
    outputRules: {
      maximumIssuesPerComponentInstance: 2,
      maximumIssuesPerBatch: 40,
      noEvidenceNoIssue: true,
      conciseJsonOnly: true
    },
    requiredOutput: outputTemplate
  };
}

function batchPayload(fixed, batch, batchIndex, batchTotal) {
  return JSON.stringify({
    ...fixed,
    batch: {
      index: batchIndex,
      total: batchTotal,
      componentCount: batch.length,
      components: batch.map((item) => item.componentFamily),
      standards: batch.map((item) => ({
        componentFamily: item.componentFamily,
        standard: item.standard
      }))
    }
  });
}

export function resolveFastModeBudget(config = {}, skillFastMode = {}) {
  const source = { ...(config.fastMode || {}), ...(skillFastMode || {}) };
  const contextWindowTokens = Math.max(16384, Number(source.contextWindowTokens) || Number(config.contextWindowTokens) || DEFAULT_CONTEXT_WINDOW);
  const reservedOutputTokens = Math.max(1200, Number(source.reservedOutputTokens) || DEFAULT_RESERVED_OUTPUT);
  const safetyRatio = Math.min(0.3, Math.max(0.05, Number(source.safetyRatio) || DEFAULT_SAFETY_RATIO));
  return { contextWindowTokens, reservedOutputTokens, safetyRatio };
}

export function packStandardsByBudget({ standards, fixedPrefixTokens, budget }) {
  const safeInputLimit = Math.floor(budget.contextWindowTokens * (1 - budget.safetyRatio)) - budget.reservedOutputTokens;
  const standardBudget = safeInputLimit - fixedPrefixTokens;
  if (standardBudget < MIN_STANDARD_BUDGET) {
    throw new Error(`快速模式固定页面证据已接近模型上下文上限：预计 ${fixedPrefixTokens} tokens，可用输入上限 ${safeInputLimit} tokens`);
  }
  const batches = [];
  let current = [];
  let currentTokens = 0;
  for (const item of standards) {
    if (item.estimatedTokens > standardBudget) {
      throw new Error(`单个组件规范 ${item.componentFamily} 预计 ${item.estimatedTokens} tokens，超过本批可用容量 ${standardBudget} tokens`);
    }
    if (current.length && currentTokens + item.estimatedTokens > standardBudget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(item);
    currentTokens += item.estimatedTokens;
  }
  if (current.length) batches.push(current);
  return { batches, safeInputLimit, standardBudget };
}

function validateReceipt(parsed, batch) {
  const receipt = parsed?.batch || {};
  const expected = batch.map((item) => item.componentFamily);
  const received = new Set(Array.isArray(receipt.receivedComponents) ? receipt.receivedComponents.map(String) : []);
  const missing = expected.filter((item) => !received.has(item));
  if (receipt.domReceived !== true) throw new Error('模型未确认收到页面证据');
  if (Number(receipt.receivedStandardCount) !== expected.length) {
    throw new Error(`模型确认收到 ${Number(receipt.receivedStandardCount) || 0}/${expected.length} 份组件规范`);
  }
  if (missing.length) throw new Error(`模型收件确认缺少组件：${missing.join('、')}`);
  if (String(receipt.lastReceivedComponent || '') !== expected.at(-1)) {
    throw new Error(`模型未确认收到本批最后一份规范：${expected.at(-1)}`);
  }
}

function normalizeBatchResults(parsed, batch, mode) {
  const byFamily = new Map((Array.isArray(parsed?.componentResults) ? parsed.componentResults : []).map((item) => [String(item?.componentFamily || ''), item]));
  return batch.map((entry) => ({
    componentFamily: entry.componentFamily,
    standardPath: entry.standardPath,
    result: normalizeComponentResult(byFamily.get(entry.componentFamily) || { componentFamily: entry.componentFamily, results: [], summary: '' }, entry.componentFamily, mode)
  }));
}

function isCapacityError(error) {
  return /context|token|too large|request.*large|上下文|长度|413|maximum/i.test(String(error?.message || error));
}

export async function auditComponentsFast(options) {
  const mode = options.mode === 'image' ? 'image' : 'dom';
  if (mode !== 'dom') throw new Error('快速模式第一期仅支持 DOM；图片模式继续使用深度检测');
  const evidence = await fs.readFile(options.evidencePath, 'utf8');
  const standards = [];
  for (const entry of options.standards || []) {
    const standard = await fs.readFile(entry.standardPath, 'utf8');
    standards.push({
      ...entry,
      standard,
      standardBytes: Buffer.byteLength(standard, 'utf8'),
      standardSha256: sha256(standard),
      estimatedTokens: estimateTextTokens(JSON.stringify({ componentFamily: entry.componentFamily, standard }))
    });
  }
  const system = fastSystemPrompt(mode);
  const fixed = fixedPayload({ mode, evidence, outputTemplate: FAST_BATCH_RESULT_TEMPLATE });
  const fixedPrefixTokens = estimateTextTokens(system) + estimateTextTokens(JSON.stringify(fixed)) + 256;
  const budget = resolveFastModeBudget(options.config, options.fastMode);
  const packing = packStandardsByBudget({ standards, fixedPrefixTokens, budget });
  const queue = packing.batches.map((batch) => ({ batch, splitDepth: 0 }));
  const completed = [];
  const failures = [];
  let callIndex = 0;
  options.onProgress?.({
    phase: 'fast:plan',
    message: `快速模式已按上下文动态生成 ${queue.length} 批：完整 DOM + ${standards.length} 份组件规范`,
    totalBatches: queue.length,
    componentCount: standards.length,
    fixedPrefixTokens,
    contextWindowTokens: budget.contextWindowTokens,
    standardBudget: packing.standardBudget
  });
  while (queue.length) {
    const work = queue.shift();
    callIndex += 1;
    const batchNumber = completed.length + 1;
    const batchTotal = completed.length + queue.length + 1;
    const components = work.batch.map((item) => item.componentFamily);
    const userContent = batchPayload(fixed, work.batch, batchNumber, batchTotal);
    options.onProgress?.({
      phase: 'ai:round:start',
      roundId: `fast-batch-${callIndex}`,
      checkedItems: components,
      message: `快速验收批次 ${batchNumber}/${batchTotal}：${components.length} 份完整规范，预计 ${estimateTextTokens(userContent) + estimateTextTokens(system)} tokens`,
      batchIndex: batchNumber,
      batchTotal,
      componentCount: components.length
    });
    try {
      const response = await callJsonModel({
        config: options.config,
        fetchImpl: options.fetchImpl,
        onProgress: options.onProgress,
        system,
        userContent,
        maxTokens: budget.reservedOutputTokens,
        reasoningEffort: options.reasoningEffort || 'low',
        schemaHint: FAST_BATCH_RESULT_TEMPLATE
      });
      validateReceipt(response.parsed, work.batch);
      const componentRuns = normalizeBatchResults(response.parsed, work.batch, mode).map((item, index) => ({
        ...item,
        model: response.model,
        // 同一批 usage 只能汇总一次，避免按组件重复累计。
        usage: index === 0 ? response.usage : null
      }));
      const issueCount = componentRuns.reduce((sum, run) => sum + run.result.results.reduce((inner, instance) => inner + instance.issues.length, 0), 0);
      const artifact = {
        batchIndex: batchNumber,
        components,
        evidencePath: options.evidencePath,
        evidenceSha256: sha256(evidence),
        fixedPrefixTokens,
        estimatedPromptTokens: estimateTextTokens(userContent) + estimateTextTokens(system),
        usage: response.usage,
        model: response.model,
        parsed: response.parsed
      };
      let manifestPath = null;
      let rawResponsePath = null;
      if (options.artifactDir) {
        await fs.mkdir(options.artifactDir, { recursive: true });
        manifestPath = path.join(options.artifactDir, `fast-batch-${String(callIndex).padStart(2, '0')}-manifest.json`);
        rawResponsePath = path.join(options.artifactDir, `fast-batch-${String(callIndex).padStart(2, '0')}-raw-response.json`);
        await fs.writeFile(manifestPath, JSON.stringify(artifact, null, 2), 'utf8');
        await fs.writeFile(rawResponsePath, JSON.stringify({ model: response.model, content: response.responseContent }, null, 2), 'utf8');
      }
      completed.push({ components, componentRuns, usage: response.usage, model: response.model, manifestPath, rawResponsePath });
      options.onProgress?.({ phase: 'ai:round:done', roundId: `fast-batch-${callIndex}`, checkedItems: components, issueCount, message: `快速批次完成，发现 ${issueCount} 条问题` });
    } catch (error) {
      if ((isCapacityError(error) || /收件确认|未确认收到|缺少组件/.test(String(error?.message || ''))) && work.batch.length > 1) {
        const middle = Math.ceil(work.batch.length / 2);
        const left = work.batch.slice(0, middle);
        const right = work.batch.slice(middle);
        queue.unshift({ batch: right, splitDepth: work.splitDepth + 1 });
        queue.unshift({ batch: left, splitDepth: work.splitDepth + 1 });
        options.onProgress?.({ phase: 'fast:split', message: `批次容量或收件确认失败，自动拆为 ${left.length} + ${right.length} 份规范重试`, components, error: error?.message || String(error) });
        continue;
      }
      failures.push({ components, error: error?.message || String(error) });
      options.onProgress?.({ phase: 'ai:round:failed', roundId: `fast-batch-${callIndex}`, checkedItems: components, message: `快速批次失败：${error?.message || error}` });
    }
  }
  const componentRuns = completed.flatMap((item) => item.componentRuns);
  const usage = completed.map((item) => item.usage).filter(Boolean).reduce((total, item) => ({
    prompt_tokens: total.prompt_tokens + Number(item.prompt_tokens || 0),
    cached_tokens: total.cached_tokens + Number(item.cached_tokens || item.prompt_tokens_details?.cached_tokens || 0),
    completion_tokens: total.completion_tokens + Number(item.completion_tokens || 0),
    total_tokens: total.total_tokens + Number(item.total_tokens || 0)
  }), { prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  return { componentRuns, completedBatches: completed, failures, usage, packing: { ...packing, budget, fixedPrefixTokens } };
}
