import fs from 'node:fs/promises';
import path from 'node:path';
import { buildSafeEvidence, compactSafeEvidenceForAi } from './safe-evidence-builder.mjs';

const DEFAULT_CONFIG = {
  enabled: true,
  provider: 'openai-compatible',
  baseUrl: 'https://api.moonshot.cn/v1',
  model: 'kimi-k3',
  apiKey: '',
  candidateModels: [],
  candidateApiKeys: [],
  temperature: 0.6,
  timeoutMs: 300000,
  fastMode: {
    contextWindowTokens: 262144,
    reservedOutputTokens: 6000,
    safetyRatio: 0.15
  }
};

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_CONFIG.baseUrl).replace(/\/+$/, '');
}

function chatUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (/\/chat\/completions$/i.test(normalized)) {
    return normalized;
  }
  return `${normalized}/chat/completions`;
}

function anthropicMessagesUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized.endsWith('/v1') ? `${normalized}/messages` : `${normalized}/v1/messages`;
}

function requestFetch(options = {}) {
  return typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
}

function networkErrorMessage(error, url) {
  const cause = error?.cause;
  const details = [
    error?.message,
    cause?.code,
    cause?.message
  ].filter(Boolean);
  if (error?.name === 'AbortError') {
    return `模型请求超时：${url}`;
  }
  return `模型网络请求失败：${details.join(' / ') || '未知网络错误'}；地址：${url}`;
}

function shouldRetryNetworkError(error) {
  const text = [
    error?.name,
    error?.message,
    error?.cause?.code,
    error?.cause?.message
  ].filter(Boolean).join(' ');
  return /ERR_CONNECTION_TIMED_OUT|ETIMEDOUT|ECONNRESET|socket hang up|network changed|temporar/i.test(text);
}

async function fetchModel(options, url, init) {
  const bodyBytes = Buffer.byteLength(String(init?.body || ''), 'utf8');
  const startedAt = Date.now();
  options.onProgress?.({
    phase: 'ai:request:start',
    message: `开始连接模型服务：${new URL(url).host}，请求体 ${Math.round(bodyBytes / 1024)}KB`,
    url,
    bodyBytes
  });
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await requestFetch(options)(url, init);
      options.onProgress?.({
        phase: 'ai:response:headers',
        message: `模型服务已响应 HTTP ${response.status}，等待并读取返回内容`,
        url,
        status: response.status,
        durationMs: Date.now() - startedAt,
        attempt
      });
      return response;
    } catch (error) {
      const retryable = attempt < 2 && shouldRetryNetworkError(error);
      options.onProgress?.({
        phase: retryable ? 'ai:request:retry' : 'ai:request:failed',
        message: retryable
          ? `模型连接不稳定，准备重试第 ${attempt + 1} 次：${networkErrorMessage(error, url)}`
          : networkErrorMessage(error, url),
        url,
        durationMs: Date.now() - startedAt,
        error: error?.message || String(error),
        causeCode: error?.cause?.code || '',
        attempt
      });
      if (retryable) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        continue;
      }
      throw new Error(networkErrorMessage(error, url), { cause: error });
    }
  }
}

function normalizeModelConfig(config = {}) {
  const timeoutMs = Number(config.timeoutMs);
  return {
    ...DEFAULT_CONFIG,
    ...config,
    enabled: Boolean(config.enabled),
    baseUrl: normalizeBaseUrl(config.baseUrl),
    model: String(config.model || DEFAULT_CONFIG.model).trim(),
    apiKey: String(config.apiKey || '').trim(),
    candidateModels: Array.isArray(config.candidateModels)
      ? config.candidateModels.map((value) => String(value || '').trim()).filter(Boolean)
      : [],
    candidateApiKeys: Array.isArray(config.candidateApiKeys)
      ? config.candidateApiKeys.map((value) => String(value || '').trim()).filter(Boolean)
      : [],
    temperature: Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : DEFAULT_CONFIG.temperature,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(180000, timeoutMs) : DEFAULT_CONFIG.timeoutMs,
    fastMode: {
      ...DEFAULT_CONFIG.fastMode,
      ...(config.fastMode && typeof config.fastMode === 'object' ? config.fastMode : {})
    }
  };
}

function uniqueList(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function maskSecret(value = '') {
  if (!value) return '';
  if (value.length <= 12) return `${value.slice(0, 4)}***`;
  return `${value.slice(0, 10)}***${value.slice(-6)}`;
}

function normalizeModelTemperature(baseUrl, model, configuredTemperature) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl).toLowerCase();
  const normalizedModel = String(model || '').toLowerCase();
  const numericTemperature = Number(configuredTemperature ?? DEFAULT_CONFIG.temperature);

  if (
    normalizedBaseUrl.includes('api.moonshot.cn') &&
    normalizedModel.startsWith('kimi-k3')
  ) {
    return 1;
  }

  return Number.isFinite(numericTemperature) ? numericTemperature : DEFAULT_CONFIG.temperature;
}

function buildOpenAiCompatiblePayload(options, current) {
  const normalizedBaseUrl = normalizeBaseUrl(options.baseUrl).toLowerCase();
  const normalizedModel = String(current?.model || '').toLowerCase();
  const payload = {
    model: current.model,
    messages: options.messages,
    temperature: normalizeModelTemperature(options.baseUrl, current.model, options.temperature),
    max_tokens: options.maxTokens || 3000,
    response_format: { type: 'json_object' }
  };

  if (normalizedBaseUrl.includes('api.moonshot.cn') && normalizedModel.startsWith('kimi-k3')) {
    payload.reasoning_effort = options.reasoningEffort || options.reasoning_effort || 'low';
  }

  return payload;
}

function isModelNotFoundError(error) {
  const text = [
    error?.message,
    error?.cause?.message
  ].filter(Boolean).join(' ');
  return /model not found/i.test(text) || /\"code\":404/i.test(text);
}

function isRetryableModelHttpFailure(status, text = '') {
  const normalized = String(text || '').toLowerCase();
  if (Number(status) === 429) return true;
  return /engine_overloaded_error|rate limit|too many requests|overloaded|try again later/.test(normalized);
}

function buildOpenAiCompatibleAttempts(options) {
  const models = uniqueList([options.model, ...(options.candidateModels || [])]);
  const apiKeys = uniqueList([options.apiKey, ...(options.candidateApiKeys || [])]);
  const attempts = [];
  for (const model of models) {
    for (const apiKey of apiKeys) {
      attempts.push({ model, apiKey });
    }
  }
  return attempts;
}

function stripCodeFence(text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractBalancedJsonObject(text) {
  const source = stripCodeFence(text);
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }

    if (char === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          return source.slice(start, index + 1);
        }
      }
    }
  }

  return '';
}

function parseJsonObject(text) {
  const clean = stripCodeFence(text);
  try {
    return JSON.parse(clean);
  } catch {
    const balanced = extractBalancedJsonObject(clean);
    if (balanced) {
      return JSON.parse(balanced);
    }
    throw new Error('模型返回内容不是可解析 JSON');
  }
}

function compactText(value, maxLength = 6000) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...<truncated>` : text;
}

function extractTextFromContentParts(parts) {
  if (!Array.isArray(parts)) return '';
  return parts.map((part) => {
    if (!part) return '';
    if (typeof part === 'string') return part;
    if (typeof part.text === 'string' && part.text.trim()) return part.text;
    if (typeof part.content === 'string' && part.content.trim()) return part.content;
    if (typeof part.output_text === 'string' && part.output_text.trim()) return part.output_text;
    if (typeof part.value === 'string' && part.value.trim()) return part.value;
    return '';
  }).filter(Boolean).join('\n');
}

function extractModelContent(data) {
  if (!data || typeof data !== 'object') return '';

  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text;
  if (typeof data.completion === 'string' && data.completion.trim()) return data.completion;
  if (typeof data.content === 'string' && data.content.trim()) return data.content;

  const directParts = extractTextFromContentParts(data.content);
  if (directParts) return directParts;

  const messageContent = data.message?.content;
  if (typeof messageContent === 'string' && messageContent.trim()) return messageContent;
  const messageParts = extractTextFromContentParts(messageContent);
  if (messageParts) return messageParts;

  const choice = Array.isArray(data.choices) ? data.choices[0] : null;
  const choiceMessage = choice?.message?.content;
  if (typeof choiceMessage === 'string' && choiceMessage.trim()) return choiceMessage;
  const choiceParts = extractTextFromContentParts(choiceMessage);
  if (choiceParts) return choiceParts;

  return '';
}

function redactModelText(value) {
  return String(value || '')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[敏感文本]')
    .replace(/\b1[3-9]\d{9}\b/g, '[敏感文本]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[敏感文本]')
    .replace(/\b[A-Za-z0-9_-]{16,}\b/g, '[敏感文本]')
    .replace(/https?:\/\/\S+/g, '[URL已脱敏]')
    .slice(0, 300);
}

function safeAuditForModel(audit = {}) {
  return {
    score: audit.score,
    stars: audit.stars,
    issueCount: Array.isArray(audit.issues) ? audit.issues.length : 0,
    issues: (audit.issues || []).slice(0, 30).map((issue) => ({
      severity: issue.severity,
      severityLabel: issue.severityLabel,
      title: redactModelText(issue.title),
      description: redactModelText(issue.description),
      delta: redactModelText(issue.delta)
    })),
    dimensions: audit.dimensions || []
  };
}

function normalizePreviewMarkers(markers, viewport = {}) {
  if (!Array.isArray(markers)) return [];
  const width = Number(viewport.width || 0);
  const height = Number(viewport.height || 0);
  return markers.map((marker, index) => {
    const center = marker?.center || {};
    let x = Number(center.x);
    let y = Number(center.y);
    if (!Number.isFinite(x)) x = Number(marker?.x);
    if (!Number.isFinite(y)) y = Number(marker?.y);
    const mode = String(marker?.coordinateMode || marker?.mode || '').toLowerCase();

    if (Number.isFinite(x) && Number.isFinite(y) && width > 0 && height > 0) {
      if (mode === 'normalized' || (x >= 0 && x <= 1 && y >= 0 && y <= 1)) {
        x *= width;
        y *= height;
      }
    }

    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return {
      label: String(marker?.label || index + 1),
      center: { x, y }
    };
  }).filter(Boolean);
}

function normalizeImageAnalysis(analysis, viewport) {
  const issues = Array.isArray(analysis?.issues) ? analysis.issues : [];
  return {
    ...analysis,
    issues: issues.map((issue, index) => {
      const markers = normalizePreviewMarkers(
        issue?.previewMarkers || issue?.markers || issue?.focusMarkers || issue?.focusPoints,
        viewport
      );
      return {
        ...issue,
        label: issue?.label || String(index + 1),
        subject: issue?.subject || '',
        location: issue?.location || '',
        actual: issue?.actual || issue?.description || '',
        standard: issue?.standard || '',
        suggestion: issue?.suggestion || '',
        previewMarkers: markers
      };
    })
  };
}

const CHECK_EVIDENCE_PROFILES = {
  'toolbar-action-gaps': {
    regions: ['page-toolbar'],
    relationRegions: ['page-toolbar'],
    elementTypes: ['button', 'clickable', 'select', 'input'],
    includeHorizontalGaps: true,
    includeActionGroups: true
  },
  'adjacent-component-gaps': {
    regions: ['content', 'page-toolbar', 'table-area'],
    relationRegions: ['content', 'page-toolbar', 'table-area'],
    elementTypes: ['button', 'input', 'select', 'pagination', 'tab', 'table', 'clickable'],
    includeHorizontalGaps: true,
    includeVerticalGaps: true,
    includeActionGroups: true
  },
  'block-stack-spacing': {
    regions: ['content', 'page-toolbar', 'table-area'],
    relationRegions: ['content', 'page-toolbar', 'table-area'],
    elementTypes: ['button', 'input', 'select', 'pagination', 'tab', 'table', 'status'],
    includeVerticalGaps: true
  },
  'component-alignment': {
    regions: ['content', 'page-toolbar', 'table-area'],
    relationRegions: ['content', 'page-toolbar', 'table-area'],
    elementTypes: ['button', 'input', 'select', 'pagination', 'tab', 'table', 'clickable'],
    includeHorizontalGaps: true,
    includeVerticalGaps: true
  },
  'label-control-alignment': {
    regions: ['content', 'form', 'page-toolbar'],
    relationRegions: ['content', 'form', 'page-toolbar'],
    elementTypes: ['input', 'select', 'clickable', 'button', 'status'],
    includeHorizontalGaps: true,
    includeVerticalGaps: true
  },
  'content-start-line': {
    regions: ['content', 'page-toolbar', 'table-area'],
    relationRegions: ['content', 'page-toolbar', 'table-area'],
    elementTypes: ['button', 'input', 'select', 'table', 'tab', 'pagination'],
    includeHorizontalGaps: true,
    includeVerticalGaps: true
  },
  'button-components': {
    regions: ['content', 'page-toolbar', 'table-area', 'sidebar'],
    relationRegions: ['content', 'page-toolbar', 'table-area', 'sidebar'],
    elementTypes: ['button'],
    includeActionGroups: true
  },
  'button-group-components': {
    regions: ['content', 'page-toolbar', 'sidebar', 'table-area'],
    relationRegions: ['content', 'page-toolbar', 'sidebar', 'table-area'],
    elementTypes: ['button'],
    includeActionGroups: true
  },
  'action-entry-components': {
    regions: ['content', 'page-toolbar', 'table-area'],
    relationRegions: ['content', 'page-toolbar', 'table-area'],
    elementTypes: ['button', 'clickable', 'pagination'],
    includeActionGroups: true
  },
  'input-components': {
    regions: ['content', 'page-toolbar', 'form'],
    relationRegions: ['content', 'page-toolbar', 'form'],
    elementTypes: ['input']
  },
  'select-components': {
    regions: ['content', 'page-toolbar', 'form', 'table-area'],
    relationRegions: ['content', 'page-toolbar', 'form', 'table-area'],
    elementTypes: ['select']
  },
  'form-control-components': {
    regions: ['content', 'page-toolbar', 'form'],
    relationRegions: ['content', 'page-toolbar', 'form'],
    elementTypes: ['input', 'select', 'button', 'clickable', 'status']
  },
  'table-components': {
    regions: ['table-area', 'content'],
    relationRegions: ['table-area', 'content'],
    elementTypes: ['table']
  },
  'table-action-components': {
    regions: ['table-area', 'content'],
    relationRegions: ['table-area', 'content'],
    elementTypes: ['table', 'button', 'clickable']
  },
  'pagination-components': {
    regions: ['table-area', 'content'],
    relationRegions: ['table-area', 'content'],
    elementTypes: ['pagination', 'button', 'clickable'],
    includeActionGroups: true
  },
  'tab-menu-components': {
    regions: ['content', 'page-toolbar', 'sidebar'],
    relationRegions: ['content', 'page-toolbar', 'sidebar'],
    elementTypes: ['tab', 'menu', 'clickable']
  },
  'status-tag-components': {
    regions: ['content', 'table-area', 'page-toolbar'],
    relationRegions: ['content', 'table-area', 'page-toolbar'],
    elementTypes: ['status', 'clickable']
  },
  'selection-components': {
    regions: ['content', 'table-area', 'form'],
    relationRegions: ['content', 'table-area', 'form'],
    elementTypes: ['clickable', 'button', 'status']
  }
};

function normalizeCheckList(checks = []) {
  return Array.isArray(checks) ? checks.map((value) => String(value || '').trim()).filter(Boolean) : [];
}

function buildMergedEvidenceProfile(checks = []) {
  const merged = {
    regions: new Set(),
    relationRegions: new Set(),
    elementTypes: new Set(),
    includeHorizontalGaps: false,
    includeVerticalGaps: false,
    includeActionGroups: false
  };
  for (const check of normalizeCheckList(checks)) {
    const profile = CHECK_EVIDENCE_PROFILES[check];
    if (!profile) continue;
    for (const region of profile.regions || []) merged.regions.add(region);
    for (const region of profile.relationRegions || []) merged.relationRegions.add(region);
    for (const type of profile.elementTypes || []) merged.elementTypes.add(type);
    merged.includeHorizontalGaps ||= Boolean(profile.includeHorizontalGaps);
    merged.includeVerticalGaps ||= Boolean(profile.includeVerticalGaps);
    merged.includeActionGroups ||= Boolean(profile.includeActionGroups);
  }
  return merged;
}

function relationTouchesKnownElement(relation = {}, allowedElementKeys = new Set()) {
  const refs = [relation?.from, relation?.to];
  return refs.some((ref) => {
    const key = [ref?.selectorHash || '', ref?.label || '', ref?.type || '', ref?.region || ''].join('::');
    return allowedElementKeys.has(key);
  });
}

function buildElementKeyLike(element = {}) {
  return [element?.selectorHash || '', element?.label || '', element?.type || '', element?.region || ''].join('::');
}

function normalizeTargetFilter(targetFilter = null) {
  if (!targetFilter || typeof targetFilter !== 'object') return null;
  const selectorHashes = Array.isArray(targetFilter.selectorHashes)
    ? targetFilter.selectorHashes.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const labels = Array.isArray(targetFilter.labels)
    ? targetFilter.labels.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const regions = Array.isArray(targetFilter.regions)
    ? targetFilter.regions.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const groupY = Number.isFinite(Number(targetFilter.groupY)) ? Number(targetFilter.groupY) : null;
  const maxElements = Number.isFinite(Number(targetFilter.maxElements)) ? Math.max(1, Number(targetFilter.maxElements)) : null;
  const maxGroups = Number.isFinite(Number(targetFilter.maxGroups)) ? Math.max(1, Number(targetFilter.maxGroups)) : null;
  const maxRelations = Number.isFinite(Number(targetFilter.maxRelations)) ? Math.max(1, Number(targetFilter.maxRelations)) : null;
  if (!selectorHashes.length && !labels.length && !regions.length && groupY == null) return null;
  return { selectorHashes, labels, regions, groupY, maxElements, maxGroups, maxRelations };
}

function targetFilterMatchesElement(element = {}, targetFilter = null) {
  if (!targetFilter) return true;
  const selectorHit = !targetFilter.selectorHashes.length || targetFilter.selectorHashes.includes(String(element.selectorHash || ''));
  const labelHit = !targetFilter.labels.length || targetFilter.labels.includes(String(element.label || ''));
  const regionHit = !targetFilter.regions.length || targetFilter.regions.includes(String(element.region || ''));
  return selectorHit && labelHit && regionHit;
}

function targetFilterMatchesActionGroup(group = {}, targetFilter = null) {
  if (!targetFilter) return true;
  const regionHit = !targetFilter.regions.length || targetFilter.regions.includes(String(group.region || ''));
  const yHit = targetFilter.groupY == null || Number(group.y) === Number(targetFilter.groupY);
  const selectorHit = !targetFilter.selectorHashes.length || (group.items || []).some((item) => targetFilter.selectorHashes.includes(String(item.selectorHash || '')));
  const labelHit = !targetFilter.labels.length || (group.items || []).some((item) => targetFilter.labels.includes(String(item.label || '')));
  return regionHit && yHit && selectorHit && labelHit;
}

function filterCompactEvidenceForChecks(compactEvidence = {}, checks = [], targetFilter = null) {
  const normalizedChecks = normalizeCheckList(checks);
  const normalizedTargetFilter = normalizeTargetFilter(targetFilter);
  if (!normalizedChecks.length && !normalizedTargetFilter) return compactEvidence;

  const profile = buildMergedEvidenceProfile(normalizedChecks);
  const allowedRegions = profile.regions;
  const allowedRelationRegions = profile.relationRegions.size ? profile.relationRegions : allowedRegions;
  const allowedElementTypes = profile.elementTypes;

  const elements = (compactEvidence.elements || []).filter((element) => {
    const regionOk = !allowedRegions.size || allowedRegions.has(element.region);
    const typeOk = !allowedElementTypes.size || allowedElementTypes.has(element.type);
    const targetOk = targetFilterMatchesElement(element, normalizedTargetFilter);
    return regionOk && typeOk && targetOk;
  });
  const allowedElementKeys = new Set(elements.map((element) => buildElementKeyLike(element)));
  const allowedSelectorHashes = new Set(elements.map((element) => String(element.selectorHash || '')).filter(Boolean));

  const horizontalGaps = (compactEvidence.relations?.horizontalGaps || [])
    .filter((relation) => {
      const regionOk = !allowedRelationRegions.size || allowedRelationRegions.has(relation.region);
      const targetOk = !normalizedTargetFilter || [relation?.from, relation?.to].some((ref) => allowedSelectorHashes.has(String(ref?.selectorHash || '')));
      return regionOk && targetOk && relationTouchesKnownElement(relation, allowedElementKeys);
    })
    .slice(0, normalizedTargetFilter?.maxRelations || 18);

  const verticalGaps = (compactEvidence.relations?.verticalGaps || [])
    .filter((relation) => {
      const regionOk = !allowedRelationRegions.size || allowedRelationRegions.has(relation.region);
      const targetOk = !normalizedTargetFilter || [relation?.from, relation?.to].some((ref) => allowedSelectorHashes.has(String(ref?.selectorHash || '')));
      return regionOk && targetOk && relationTouchesKnownElement(relation, allowedElementKeys);
    })
    .slice(0, normalizedTargetFilter?.maxRelations || 18);

  const actionGroups = (compactEvidence.relations?.actionGroups || [])
    .filter((group) => {
      const regionOk = !allowedRelationRegions.size || allowedRelationRegions.has(group.region);
      const itemHit = (group.items || []).some((item) => {
        const key = buildElementKeyLike(item);
        return allowedElementKeys.has(key) || allowedSelectorHashes.has(String(item?.selectorHash || ''));
      });
      const targetOk = targetFilterMatchesActionGroup(group, normalizedTargetFilter);
      return regionOk && targetOk && itemHit;
    })
    .slice(0, normalizedTargetFilter?.maxGroups || 6);

  return {
    ...compactEvidence,
    elements: elements.slice(0, normalizedTargetFilter?.maxElements || 12),
    relations: {
      horizontalGaps: profile.includeHorizontalGaps ? horizontalGaps : [],
      verticalGaps: profile.includeVerticalGaps ? verticalGaps : [],
      actionGroups: profile.includeActionGroups ? actionGroups : []
    }
  };
}

function buildEvidencePayload(runtime, audit, checks = [], targetFilter = null) {
  const safeEvidence = runtime.safeEvidence || buildSafeEvidence(runtime);
  const compactEvidence = compactSafeEvidenceForAi(safeEvidence);
  return {
    deterministicAudit: safeAuditForModel(audit),
    safeEvidence: filterCompactEvidenceForChecks(compactEvidence, checks, targetFilter)
  };
}

async function readIfExists(filePath, maxLength = 5000) {
  try {
    return compactText(await fs.readFile(filePath, 'utf8'), maxLength);
  } catch {
    return '';
  }
}

async function readJsonIfExists(filePath, maxLength = 5000) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return compactText(raw, maxLength);
  } catch {
    return '';
  }
}

async function readBinaryAsDataUrl(filePath, mimeType = 'image/png') {
  try {
    const raw = await fs.readFile(filePath);
    return `data:${mimeType};base64,${raw.toString('base64')}`;
  } catch {
    return '';
  }
}

async function readDomSnapshotForAi(runtime = {}, maxLength = 50000) {
  const direct = String(runtime?.domSnapshotPruned || '').trim();
  if (direct) return compactText(direct, maxLength);
  const filePath = runtime?.domSnapshot?.prunedPath || runtime?.domSnapshotPath || '';
  if (!filePath) return '';
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return compactText(raw, maxLength);
  } catch {
    return '';
  }
}

function pickButtonStandardsForAi(standards = {}) {
  return {
    selectedSkin: standards.selectedSkin || null,
    button: standards.button || null
  };
}

function buttonRoundSchemaHint() {
  return {
    candidateButtons: [
      {
        componentName: 'string',
        matchedVariant: 'primary|default|danger|guide|icon|unknown',
        confidence: 'number',
        issues: [
          {
            location: 'string',
            problem: 'string',
            severity: 'low|medium|high'
          }
        ]
      }
    ],
    summary: 'string'
  };
}

function convertButtonRoundResultToIssues(parsed = {}, passId = 'component-style-pass') {
  const candidateButtons = Array.isArray(parsed?.candidateButtons) ? parsed.candidateButtons : [];
  const issues = [];
  candidateButtons.forEach((button) => {
    const componentName = String(button?.componentName || '按钮').trim() || '按钮';
    const matchedVariant = String(button?.matchedVariant || 'unknown').trim() || 'unknown';
    const confidence = Number(button?.confidence);
    const buttonIssues = Array.isArray(button?.issues) ? button.issues : [];
    buttonIssues.forEach((item, index) => {
      const severity = item?.severity === 'high' ? 'severe' : item?.severity === 'medium' ? 'medium' : 'minor';
      issues.push({
        severity,
        severityLabel: severity === 'severe' ? '严重' : severity === 'medium' ? '中等' : '轻微',
        title: `${componentName}样式不符合规范`,
        subject: componentName,
        location: String(item?.location || '').trim(),
        actual: String(item?.problem || '').trim(),
        standard: `应匹配 ${matchedVariant} 按钮规范`,
        suggestion: `按 ${matchedVariant} 按钮规范修正该组件`,
        description: String(item?.problem || '').trim(),
        delta: Number.isFinite(confidence) ? `匹配 ${matchedVariant}，置信度 ${confidence}` : `匹配 ${matchedVariant}`,
        sourcePass: passId,
        sourceDimension: passDimensionName(passId),
        previewMarkers: []
      });
      void index;
    });
  });
  return {
    summary: String(parsed?.summary || '').trim(),
    issues
  };
}

export function defaultModelConfig() {
  return { ...DEFAULT_CONFIG };
}

export async function loadModelConfig(configPath) {
  try {
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    return normalizeModelConfig(raw);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveModelConfig(configPath, config) {
  const normalized = normalizeModelConfig(config);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

export async function testModelConfig(config) {
  const merged = { ...DEFAULT_CONFIG, ...config };
  const response = await callModel({
    ...DEFAULT_CONFIG,
    ...merged,
    messages: [
      { role: 'system', content: '你是 UXChecker 的模型连接测试。' },
      { role: 'user', content: '只返回 JSON：{"ok":true,"message":"connected"}' }
    ],
    maxTokens: 80
  });
  return {
    ok: true,
    model: response.model || config.model,
    message: response.content.slice(0, 200)
  };
}

async function callChatCompletion(options) {
  if (!options.apiKey) throw new Error('请先配置模型 API Key');
  const url = chatUrl(options.baseUrl);
  const attempts = buildOpenAiCompatibleAttempts(options);
  let lastError = null;

  for (let index = 0; index < attempts.length; index += 1) {
    const current = attempts[index];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs) || DEFAULT_CONFIG.timeoutMs);
    try {
      options.onProgress?.({
        phase: 'ai:model-candidate:start',
        message: `尝试模型候选 ${index + 1}/${attempts.length}：${current.model}，Key ${maskSecret(current.apiKey)}`,
        model: current.model,
        key: maskSecret(current.apiKey),
        candidateIndex: index + 1,
        candidateTotal: attempts.length
      });
      const payload = buildOpenAiCompatiblePayload(options, current);
      let res;
      let text = '';
      for (let httpAttempt = 1; httpAttempt <= 3; httpAttempt += 1) {
        res = await fetchModel(options, url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${current.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        text = await res.text();
        options.onProgress?.({
          phase: 'ai:response:body',
          message: `模型返回内容读取完成：${Math.round(Buffer.byteLength(text, 'utf8') / 1024)}KB`,
          responseBytes: Buffer.byteLength(text, 'utf8'),
          httpAttempt
        });
        const shouldRetryHttp = !res.ok && httpAttempt < 3 && isRetryableModelHttpFailure(res.status, text);
        if (shouldRetryHttp) {
          options.onProgress?.({
            phase: 'ai:response:retry',
            message: `模型服务暂时繁忙（HTTP ${res.status}），${1500 * httpAttempt}ms 后重试第 ${httpAttempt + 1} 次`,
            status: res.status,
            httpAttempt
          });
          await new Promise((resolve) => setTimeout(resolve, 1500 * httpAttempt));
          continue;
        }
        break;
      }

      if (!res.ok && /response_format|json_object/i.test(text)) {
        delete payload.response_format;
        res = await fetchModel(options, url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${current.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        text = await res.text();
        options.onProgress?.({
          phase: 'ai:response:body',
          message: `模型去掉 response_format 后返回内容读取完成：${Math.round(Buffer.byteLength(text, 'utf8') / 1024)}KB`,
          responseBytes: Buffer.byteLength(text, 'utf8')
        });
      }
      if (!res.ok && /reasoning_effort/i.test(text)) {
        delete payload.reasoning_effort;
        res = await fetchModel(options, url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${current.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        text = await res.text();
        options.onProgress?.({
          phase: 'ai:response:body',
          message: `模型去掉 reasoning_effort 后返回内容读取完成：${Math.round(Buffer.byteLength(text, 'utf8') / 1024)}KB`,
          responseBytes: Buffer.byteLength(text, 'utf8')
        });
      }
      if (!res.ok) {
        throw new Error(`模型请求失败 ${res.status}: ${text.slice(0, 500)}`);
      }
      const data = JSON.parse(text);
      options.onProgress?.({
        phase: 'ai:model-candidate:success',
        message: `模型候选命中：${current.model}`,
        model: current.model,
        key: maskSecret(current.apiKey),
        candidateIndex: index + 1,
        candidateTotal: attempts.length
      });
      return {
        raw: data,
        model: data.model || current.model,
        content: extractModelContent(data)
      };
    } catch (error) {
      lastError = error;
      const canContinue = index < attempts.length - 1 && isModelNotFoundError(error);
      options.onProgress?.({
        phase: canContinue ? 'ai:model-candidate:miss' : 'ai:model-candidate:failed',
        message: canContinue
          ? `模型候选未命中：${current.model}，继续尝试下一组`
          : `模型候选失败：${current.model}，${error.message}`,
        model: current.model,
        key: maskSecret(current.apiKey),
        candidateIndex: index + 1,
        candidateTotal: attempts.length,
        error: error.message
      });
      if (!canContinue) {
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error('模型请求失败');
}

async function callAnthropicMessages(options) {
  if (!options.apiKey) throw new Error('请先配置模型 API Key');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs) || DEFAULT_CONFIG.timeoutMs);
  const system = options.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const messages = options.messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: Array.isArray(message.content) ? message.content : String(message.content || '')
    }));
  try {
    const url = anthropicMessagesUrl(options.baseUrl);
    const payload = {
      model: options.model,
      max_tokens: options.maxTokens || 3000,
      temperature: Number(options.temperature ?? 0.6),
      system,
      messages,
      thinking: { type: 'disabled' }
    };
    const res = await fetchModel(options, url, {
      method: 'POST',
      headers: {
        'x-api-key': options.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await res.text();
    options.onProgress?.({
      phase: 'ai:response:body',
      message: `模型返回内容读取完成：${Math.round(Buffer.byteLength(text, 'utf8') / 1024)}KB`,
      responseBytes: Buffer.byteLength(text, 'utf8')
    });
    if (!res.ok) {
      throw new Error(`模型请求失败 ${res.status}: ${text.slice(0, 500)}`);
    }
    const data = JSON.parse(text);
    const content = extractModelContent(data);
    return {
      raw: data,
      model: data.model,
      content
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function callModel(options) {
  if (options.provider === 'kimi-coding-anthropic' || options.provider === 'anthropic-compatible') {
    return callAnthropicMessages(options);
  }
  return callChatCompletion(options);
}

export async function callJsonModel({ config, system, payload, userContent, messages, schemaHint, fetchImpl, onProgress, maxTokens = 3200, reasoningEffort }) {
  const response = await callModel({
    ...DEFAULT_CONFIG,
    ...config,
    fetchImpl,
    onProgress,
    temperature: 0,
    maxTokens,
    reasoningEffort,
    messages: messages || [
      { role: 'system', content: system },
      { role: 'user', content: userContent ?? JSON.stringify(payload) }
    ]
  });
  let parsed;
  try {
    parsed = parseJsonObject(response.content);
  } catch {
    parsed = await recoverJsonObjectWithModel({
      config,
      fetchImpl,
      onProgress,
      invalidContent: response.content,
      schemaHint,
      modeLabel: 'DOM 单组件验收'
    });
  }
  return {
    parsed,
    model: response.model || config.model,
    raw: response.raw,
    usage: response.raw?.usage || null,
    responseContent: response.content,
    rawResponsePath: null
  };
}

async function recoverJsonObjectWithModel({
  config,
  fetchImpl,
  onProgress,
  invalidContent,
  schemaHint,
  modeLabel = '验收'
}) {
  onProgress?.({
    phase: 'ai:repair:start',
    message: `${modeLabel}结果 JSON 不完整，正在请求模型修复为严格 JSON`
  });
  const response = await callModel({
    ...DEFAULT_CONFIG,
    ...config,
    fetchImpl,
    onProgress,
    temperature: 0,
    maxTokens: 2600,
    messages: [
      {
        role: 'system',
        content: [
          '你是 JSON 修复助手。',
          '你会把用户给出的近似 JSON 或残缺 JSON 修复成一个可被 JSON.parse 直接解析的 JSON object。',
          '不要输出 markdown，不要解释，不要代码围栏。',
          '如果原文缺少某些字段值，必须保留字段结构，并用空数组、空字符串、0 或 “需复核” 这类最小占位值补齐。'
        ].join('\n')
      },
      {
        role: 'user',
        content: JSON.stringify({
          task: '把下面模型返回内容修复成严格 JSON object',
          schemaHint,
          invalidContent: compactText(invalidContent, 18000)
        })
      }
    ]
  });
  const parsed = parseJsonObject(response.content);
  onProgress?.({
    phase: 'ai:repair:done',
    message: '模型修复后的 JSON 已可解析'
  });
  return parsed;
}

async function loadMultiroundProfile(skillDir) {
  try {
    const filePath = path.join(skillDir, 'framework', 'methodology', 'multiround-audit-profile.json');
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function pickStandardsSubsetForPass(standards, passId) {
  const shared = {
    standardsVersion: standards.standardsVersion,
    selectedSkin: standards.selectedSkin,
    scoring: standards.scoring,
    normalization: standards.normalization
  };
  switch (passId) {
    case 'layout-pass':
      return {
        ...shared,
        coreOverview: standards.coreOverview,
        layoutOverview: standards.layoutOverview,
        layoutRules: standards.layoutRules
      };
    case 'component-style-pass':
      return {
        ...shared,
        coreOverview: standards.coreOverview,
        button: standards.button,
        table: standards.table,
        input: standards.input,
        select: standards.select,
        switch: standards.switch,
        pagination: standards.pagination,
        tab: standards.tab,
        aiOverview: standards.aiOverview,
        aiComponents: standards.aiComponents
      };
    case 'typography-pass':
      return {
        ...shared,
        typographyOverview: standards.typographyOverview,
        typographyDetection: standards.typographyDetection,
        typographyBase: standards.typographyBase,
        typographyAiAdjustments: standards.typographyAiAdjustments,
        fontFoundation: standards.fontFoundation
      };
    case 'skin-pass':
      return {
        ...shared,
        skinRouting: standards.skinRouting,
        skinFamilyMap: standards.skinFamilyMap,
        skinIndex: standards.skinIndex,
        skinReadme: standards.skinReadme,
        skinTokens: standards.skinTokens,
        skinTokensMd: standards.skinTokensMd,
        skinMetadata: standards.skinMetadata
      };
    default:
      return standards;
  }
}

function pickStandardsSubsetForChecks(standards, checks = []) {
  const normalizedChecks = normalizeCheckList(checks);
  if (!normalizedChecks.length) return standards;
  const includesAny = (expected = []) => normalizedChecks.some((check) => expected.includes(check));
  const shared = {
    standardsVersion: standards.standardsVersion,
    selectedSkin: standards.selectedSkin,
    normalization: standards.normalization
  };

  if (includesAny([
    'button-components',
    'button-group-components'
  ])) {
    return {
      ...shared,
      button: standards.button,
      typographyBase: standards.typographyBase,
      fontFoundation: standards.fontFoundation,
      skinMetadata: standards.skinMetadata,
      skinTokens: standards.skinTokens
    };
  }

  if (includesAny([
    'toolbar-action-gaps',
    'adjacent-component-gaps',
    'block-stack-spacing',
    'component-alignment',
    'label-control-alignment',
    'content-start-line'
  ])) {
    return pickStandardsSubsetForPass(standards, 'layout-pass');
  }

  if (includesAny([
    'action-entry-components',
    'input-components',
    'select-components',
    'form-control-components',
    'table-components',
    'table-action-components',
    'pagination-components',
    'tab-menu-components',
    'status-tag-components',
    'selection-components'
  ])) {
    return pickStandardsSubsetForPass(standards, 'component-style-pass');
  }

  return standards;
}

function passDimensionName(passId) {
  const normalizedPassId = String(passId || '');
  switch (passId) {
    case 'layout-pass':
      return '布局与内容还原度';
    case 'component-style-pass':
      return '组件视觉规范';
    case 'typography-pass':
      return '字体与字体系';
    case 'skin-pass':
      return '皮肤差异';
    default:
      if (normalizedPassId.startsWith('layout-pass')) return '布局与内容还原度';
      if (normalizedPassId.startsWith('component-style-pass')) return '组件视觉规范';
      if (normalizedPassId.startsWith('typography-pass')) return '字体与字体系';
      if (normalizedPassId.startsWith('skin-pass')) return '皮肤差异';
      return '综合';
  }
}

function roundTypeLabel(targetType = '', checks = []) {
  const normalizedTargetType = String(targetType || '');
  if (normalizedTargetType.startsWith('button-group')) return '按钮组';
  if (normalizedTargetType.startsWith('button-single')) return '按钮';
  if (normalizedTargetType.startsWith('button-fallback')) return '按钮回退';
  if (normalizedTargetType.startsWith('input-single')) return '输入框';
  if (normalizedTargetType.startsWith('select-single')) return '下拉框';
  const normalizedChecks = normalizeCheckList(checks);
  if (normalizedChecks.includes('button-components') || normalizedChecks.includes('button-group-components')) return '按钮';
  if (normalizedChecks.includes('input-components')) return '输入框';
  if (normalizedChecks.includes('select-components')) return '下拉框';
  return '组件';
}

function basePassId(passId = '') {
  if (String(passId).startsWith('layout-pass')) return 'layout-pass';
  if (String(passId).startsWith('component-style-pass')) return 'component-style-pass';
  if (String(passId).startsWith('typography-pass')) return 'typography-pass';
  if (String(passId).startsWith('skin-pass')) return 'skin-pass';
  return String(passId || '');
}

function normalizeAiIssue(issue = {}, passId, index = 0) {
  const normalizedPassId = basePassId(passId);
  return {
    severity: issue.severity || 'minor',
    severityLabel: issue.severityLabel || (issue.severity === 'severe' ? '严重' : issue.severity === 'medium' ? '中等' : '轻微'),
    title: issue.title || `${passDimensionName(normalizedPassId)}问题 ${index + 1}`,
    subject: issue.subject || '',
    location: issue.location || '',
    actual: issue.actual || '',
    standard: issue.standard || '',
    suggestion: issue.suggestion || '',
    description: issue.description || '',
    delta: issue.delta || '',
    sourcePass: issue.sourcePass || normalizedPassId,
    sourceDimension: issue.sourceDimension || passDimensionName(normalizedPassId),
    previewMarkers: Array.isArray(issue.previewMarkers) ? issue.previewMarkers : []
  };
}

function dedupeAiIssues(issues = []) {
  const seen = new Set();
  const output = [];
  for (const issue of issues) {
    const key = [
      issue.sourcePass || '',
      issue.sourceDimension || '',
      issue.subject || '',
      issue.location || '',
      issue.title || '',
      issue.delta || ''
    ].join('::');
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(issue);
  }
  return output;
}

function mergePassComponents(rounds = []) {
  const seen = new Set();
  const merged = [];
  for (const round of rounds) {
    for (const component of round.components || []) {
      const key = `${component.name || ''}::${component.status || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(component);
    }
  }
  return merged;
}

function chunkArray(values = [], size = 3) {
  const output = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function buildEvidenceStats(roundEvidence = {}) {
  const safeEvidence = roundEvidence?.safeEvidence || {};
  const elements = Array.isArray(safeEvidence.elements) ? safeEvidence.elements : [];
  const relations = safeEvidence.relations || {};
  return {
    elementCount: elements.length,
    buttonCount: elements.filter((element) => element.type === 'button').length,
    inputCount: elements.filter((element) => element.type === 'input').length,
    selectCount: elements.filter((element) => element.type === 'select').length,
    actionGroupCount: Array.isArray(relations.actionGroups) ? relations.actionGroups.length : 0,
    horizontalGapCount: Array.isArray(relations.horizontalGaps) ? relations.horizontalGaps.length : 0,
    verticalGapCount: Array.isArray(relations.verticalGaps) ? relations.verticalGaps.length : 0
  };
}

function parsePxNumber(value) {
  if (value == null) return null;
  const match = String(value).match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function compactButtonStyle(style = {}) {
  return {
    color: style.color || '',
    backgroundColor: style.backgroundColor || '',
    borderColor: style.borderColor || '',
    borderWidth: parsePxNumber(style.borderWidth),
    borderRadius: parsePxNumber(style.borderRadius),
    fontSize: parsePxNumber(style.fontSize),
    fontWeight: style.fontWeight || '',
    lineHeight: parsePxNumber(style.lineHeight),
    padding: style.padding || '',
    boxShadow: style.boxShadow || '',
    opacity: style.opacity || ''
  };
}

function buildButtonAuditFacts(roundEvidence = {}, targetLabel = '') {
  const elements = Array.isArray(roundEvidence?.safeEvidence?.elements) ? roundEvidence.safeEvidence.elements : [];
  const actionGroups = Array.isArray(roundEvidence?.safeEvidence?.relations?.actionGroups)
    ? roundEvidence.safeEvidence.relations.actionGroups
    : [];
  const horizontalGaps = Array.isArray(roundEvidence?.safeEvidence?.relations?.horizontalGaps)
    ? roundEvidence.safeEvidence.relations.horizontalGaps
    : [];

  const buttonFacts = elements
    .filter((element) => element.type === 'button')
    .map((element) => ({
      uid: element.uid,
      label: element.label || '',
      selectorHash: element.selectorHash || '',
      region: element.region || '',
      role: element.role || '',
      tagName: element.tagName || '',
      box: element.box || {},
      size: {
        width: Number(element.box?.width || 0),
        height: Number(element.box?.height || 0)
      },
      center: {
        x: Math.round(Number(element.box?.x || 0) + Number(element.box?.width || 0) / 2),
        y: Math.round(Number(element.box?.y || 0) + Number(element.box?.height || 0) / 2)
      },
      states: {
        clickable: Boolean(element.states?.clickable),
        focusable: Boolean(element.states?.focusable),
        disabled: Boolean(element.states?.disabled),
        selected: Boolean(element.states?.selected),
        checked: element.states?.checked ?? null
      },
      style: compactButtonStyle(element.style || {})
    }));

  const buttonKeyMap = new Map(buttonFacts.map((fact) => [String(fact.selectorHash || ''), fact]));
  const groupFacts = actionGroups.map((group, index) => ({
    id: `group_${index + 1}`,
    region: group.region || '',
    y: Number(group.y || 0),
    count: Number(group.count || 0),
    items: (group.items || []).map((item) => {
      const matched = buttonKeyMap.get(String(item.selectorHash || ''));
      return {
        selectorHash: item.selectorHash || '',
        label: item.label || '',
        uid: matched?.uid || '',
        center: matched?.center || null,
        size: matched?.size || null
      };
    }),
    gaps: Array.isArray(group.gaps) ? group.gaps.slice(0, 12) : []
  }));

  const relevantGapFacts = horizontalGaps
    .filter((gap) => String(gap.from?.type || '') === 'button' && String(gap.to?.type || '') === 'button')
    .map((gap) => ({
      region: gap.region || '',
      from: {
        label: gap.from?.label || '',
        selectorHash: gap.from?.selectorHash || '',
        box: gap.from?.box || {}
      },
      to: {
        label: gap.to?.label || '',
        selectorHash: gap.to?.selectorHash || '',
        box: gap.to?.box || {}
      },
      gap: Number(gap.gap || 0),
      centerDeltaY: Number(gap.centerDeltaY || 0),
      verticalOverlap: Number(gap.verticalOverlap || 0)
    }));

  return {
    targetLabel,
    buttonCount: buttonFacts.length,
    groupCount: groupFacts.length,
    buttons: buttonFacts,
    actionGroups: groupFacts,
    buttonHorizontalGaps: relevantGapFacts
  };
}

function buildButtonRoleGuide() {
  return {
    source: '界面生成skills/component-library/references/angular/components',
    baseTag: 'button.plx-btn',
    principle: [
      '先判断当前按钮更像哪一种按钮角色，再按该角色规范比较实际样式。',
      '不要因为按钮文本是“新增/保存/删除”就直接定角色，必须结合视觉样式、位置、同组关系、是否带图标、是否禁用来判断。',
      '如果证据不足以唯一确定角色，应在最接近的 1~2 个角色中说明，并给出当前采用的判定理由。'
    ],
    roles: [
      {
        id: 'primary-guide',
        aliases: ['关键按钮', '主按钮', 'Primary'],
        visualTraits: [
          '蓝色实心背景',
          '白色文字',
          '视觉权重最高',
          '常用于页面主操作，如新建、保存、确认'
        ],
        classHints: ['plx-btn-guide', 'plx-btn-primary'],
        placementHints: [
          '同一操作区通常只有一个主按钮',
          '在按钮组里通常承担最高优先级动作'
        ]
      },
      {
        id: 'basic-default',
        aliases: ['普通按钮', '次按钮', 'Default', 'Basic'],
        visualTraits: [
          '白底或浅底',
          '有边框',
          '视觉权重低于主按钮'
        ],
        classHints: ['plx-btn-basic', 'plx-btn'],
        placementHints: [
          '常作为次要操作',
          '可与主按钮并列出现'
        ]
      },
      {
        id: 'link-text',
        aliases: ['文字按钮', 'Link'],
        visualTraits: [
          '无实体边框或无实心背景',
          '更接近纯文字入口'
        ],
        classHints: ['plx-btn-link'],
        placementHints: [
          '视觉最轻',
          '常用于弱操作或补充操作'
        ]
      },
      {
        id: 'danger-error',
        aliases: ['危险按钮', '删除按钮', 'Danger', 'Error'],
        visualTraits: [
          '红色主色系',
          '强调破坏性操作'
        ],
        classHints: ['plx-btn-error', 'plx-btn-danger'],
        placementHints: [
          '用于删除、清空、移除等高风险动作',
          '若为禁用态，应按禁用危险按钮判断'
        ]
      },
      {
        id: 'icon-only',
        aliases: ['图标按钮', 'Icon Button'],
        visualTraits: [
          '仅图标，无文字',
          '通常接近正方形点击区'
        ],
        classHints: ['plx-icon-btn'],
        placementHints: [
          '常位于工具栏',
          '通常依赖 tooltip 解释含义'
        ]
      },
      {
        id: 'icon-with-text',
        aliases: ['图标+文字按钮'],
        visualTraits: [
          '左侧图标 + 右侧文字',
          '比纯图标按钮语义更明确'
        ],
        classHints: ['plx-icon-word-btn'],
        placementHints: [
          '常用于导入、下载、新建等带图标操作'
        ]
      },
      {
        id: 'more-dropdown',
        aliases: ['更多按钮', '下拉按钮'],
        visualTraits: [
          '带下拉箭头或明显下拉触发特征',
          '点击后展开更多操作'
        ],
        classHints: ['dropdown-toggle', 'plx-btn-more'],
        placementHints: [
          '用于收纳多个次要操作',
          '不应按主按钮角色判断'
        ]
      },
      {
        id: 'table-action',
        aliases: ['表格操作按钮', '表格小按钮'],
        visualTraits: [
          '尺寸更小',
          '常出现在表格操作列'
        ],
        classHints: ['plx-btn-sm', 'plx-btn-table'],
        placementHints: [
          '通常为行内操作',
          '优先按表格操作按钮规范判断，而不是页级主按钮'
        ]
      },
      {
        id: 'disabled-variant',
        aliases: ['禁用态按钮'],
        visualTraits: [
          '整体变灰或透明度降低',
          '不可点击'
        ],
        classHints: ['disabled attribute / disabled style'],
        placementHints: [
          '先识别它原始角色，再按该角色的禁用态标准判断',
          '不能把禁用主按钮误判成默认次按钮'
        ]
      }
    ]
  };
}

function toCheckLabel(value = '') {
  return String(value || '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildButtonFocusedRoundPlan(runtime, audit, profile = null) {
  const evidence = buildEvidencePayload(runtime, audit, ['button-components', 'button-group-components']);
  const safeEvidence = evidence.safeEvidence || {};
  const actionGroups = Array.isArray(safeEvidence.relations?.actionGroups) ? safeEvidence.relations.actionGroups : [];
  const buttonElements = Array.isArray(safeEvidence.elements)
    ? safeEvidence.elements.filter((element) => element.type === 'button')
    : [];

  const rounds = [];
  const groupedSelectorHashes = new Set();
  actionGroups.forEach((group, index) => {
    const items = Array.isArray(group.items) ? group.items : [];
    const groupChunks = chunkArray(items, 3);
    groupChunks.forEach((groupChunk, chunkIndex) => {
      const selectorHashes = groupChunk.map((item) => String(item.selectorHash || '')).filter(Boolean);
      selectorHashes.forEach((value) => groupedSelectorHashes.add(value));
      const labels = groupChunk.map((item) => String(item.label || '').trim()).filter(Boolean);
      if (!selectorHashes.length && !labels.length) return;
      rounds.push({
        passId: 'component-style-pass',
        roundId: `component-style-pass-button-group-${index + 1}-${chunkIndex + 1}`,
        purpose: '只检查这一组按钮组件的样式、状态、角色分配和组内关系是否符合当前皮肤。',
        checks: ['button-group-components'],
        maxIssues: 8,
        targetFilter: {
          selectorHashes,
          labels,
          regions: [String(group.region || '')].filter(Boolean),
          groupY: group.y,
          maxElements: Math.max(4, selectorHashes.length + 2),
          maxGroups: 1,
          maxRelations: 8
        },
        targetLabel: labels.join(' / ') || `按钮组 ${index + 1}-${chunkIndex + 1}`,
        targetType: 'button-group'
      });
    });
  });

  const standaloneButtons = buttonElements.filter((element) => !groupedSelectorHashes.has(String(element.selectorHash || '')));
  for (const chunk of chunkArray(standaloneButtons, 1)) {
    const labels = chunk.map((item) => String(item.label || '').trim()).filter(Boolean);
    const selectorHashes = chunk.map((item) => String(item.selectorHash || '')).filter(Boolean);
    rounds.push({
      passId: 'component-style-pass',
      roundId: `component-style-pass-button-single-${rounds.length + 1}`,
      purpose: '只检查这一批独立按钮的样式、状态和角色分配是否符合当前皮肤。',
      checks: ['button-components'],
      maxIssues: 8,
      targetFilter: {
        selectorHashes,
        labels,
        regions: Array.from(new Set(chunk.map((item) => String(item.region || '')).filter(Boolean))),
        maxElements: Math.max(2, selectorHashes.length + 1),
        maxGroups: 2,
        maxRelations: 4
      },
      targetLabel: labels.join(' / ') || `独立按钮批次 ${rounds.length + 1}`,
      targetType: 'button-single'
    });
  }

  if (!rounds.length) {
    rounds.push({
      passId: 'component-style-pass',
      roundId: 'component-style-pass-button-fallback',
      purpose: '页面未识别到明确按钮组，回退为全页按钮样式检查。',
      checks: ['button-components'],
      maxIssues: 8,
      targetFilter: {
        regions: ['content', 'page-toolbar', 'table-area', 'sidebar'],
        maxElements: 10,
        maxGroups: 2,
        maxRelations: 6
      },
      targetLabel: '全页按钮回退检查',
      targetType: 'button-fallback'
    });
  }

  return rounds;
}

function buildSingleComponentRounds(runtime, audit, options = {}) {
  const {
    type = '',
    check = '',
    passId = 'component-style-pass',
    purpose = '',
    targetPrefix = type || 'component'
  } = options;
  if (!type || !check) return [];

  const evidence = buildEvidencePayload(runtime, audit, [check]);
  const safeEvidence = evidence.safeEvidence || {};
  const elements = Array.isArray(safeEvidence.elements)
    ? safeEvidence.elements.filter((element) => element.type === type)
    : [];

  const rounds = [];
  for (const chunk of chunkArray(elements, 1)) {
    const labels = chunk.map((item) => String(item.label || '').trim()).filter(Boolean);
    const selectorHashes = chunk.map((item) => String(item.selectorHash || '')).filter(Boolean);
    rounds.push({
      passId,
      roundId: `${passId}-${targetPrefix}-single-${rounds.length + 1}`,
      purpose,
      checks: [check],
      maxIssues: 6,
      targetFilter: {
        selectorHashes,
        labels,
        regions: Array.from(new Set(chunk.map((item) => String(item.region || '')).filter(Boolean))),
        maxElements: Math.max(2, selectorHashes.length + 1),
        maxGroups: 0,
        maxRelations: 2
      },
      targetLabel: labels.join(' / ') || `${type} 批次 ${rounds.length + 1}`,
      targetType: `${type}-single`
    });
  }

  return rounds;
}

function buildRoundPlan(runtime, audit, profile = null) {
  const selectedSkin = profile?.selectedSkin || null;
  void selectedSkin;
  return [
    ...buildButtonFocusedRoundPlan(runtime, audit, profile),
    ...buildSingleComponentRounds(runtime, audit, {
      type: 'input',
      check: 'input-components',
      purpose: '只检查这一批输入框组件的高度、圆角、边框、背景和状态是否符合当前皮肤。',
      targetPrefix: 'input'
    }),
    ...buildSingleComponentRounds(runtime, audit, {
      type: 'select',
      check: 'select-components',
      purpose: '只检查这一批下拉选择组件的高度、圆角、边框、背景和状态是否符合当前皮肤。',
      targetPrefix: 'select'
    })
  ];
}

function buildAuditPlanDocument({ runId, mode = 'dom', selectedSkin = null, passes = [] }) {
  const steps = [
    ...passes.map((pass, index) => ({
      id: pass.roundId,
      passId: pass.passId,
      type: basePassId(pass.passId),
      title: `${passDimensionName(pass.passId)} · ${roundTypeLabel(pass.targetType, pass.checks)} 第 ${index + 1} 轮`,
      checks: Array.isArray(pass.checks) ? pass.checks : [],
      status: 'pending',
      resultFile: `${pass.roundId}.json`,
      rawFile: `${pass.roundId}-raw-response.json`,
      order: index + 1
    })),
    {
      id: 'summary-pass',
      passId: 'summary-pass',
      type: 'summary',
      title: '最终汇总轮',
      checks: ['final-summary', 'weighted-score', 'final-report'],
      status: 'pending',
      resultFile: 'summary-pass.json',
      rawFile: 'summary-pass-raw-response.json',
      order: passes.length + 1
    }
  ];

  return {
    version: '1.0.0',
    runId,
    mode,
    status: 'running',
    currentStep: 0,
    selectedSkin: selectedSkin || null,
    steps
  };
}

async function writeAuditPlan(planPath, plan) {
  await fs.writeFile(planPath, JSON.stringify(plan, null, 2), 'utf8');
}

async function updateAuditPlan(planPath, updater) {
  let plan = {};
  try {
    plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
  } catch {
    plan = {};
  }
  const nextPlan = typeof updater === 'function' ? updater(plan) || plan : plan;
  await writeAuditPlan(planPath, nextPlan);
  return nextPlan;
}

async function callJsonModelRound({
  config,
  fetchImpl,
  onProgress,
  runDir,
  roundId,
  systemLines,
  userPayload,
  schemaHint,
  maxTokens = 2600,
  temperature = DEFAULT_CONFIG.temperature
}) {
  onProgress?.({
    phase: 'ai:round:start',
    message: `AI 多轮验收：开始 ${roundId}`,
    roundId
  });
  const requestPath = path.join(runDir, `${roundId}-request.json`);
  await fs.writeFile(requestPath, JSON.stringify({
    roundId,
    createdAt: new Date().toISOString(),
    provider: config.provider,
    model: config.model,
    temperature,
    maxTokens,
    system: systemLines,
    userPayload
  }, null, 2), 'utf8');
  const response = await callModel({
    ...DEFAULT_CONFIG,
    ...config,
    fetchImpl,
    onProgress,
    temperature,
    maxTokens,
    messages: [
      { role: 'system', content: systemLines.join('\n') },
      { role: 'user', content: JSON.stringify(userPayload) }
    ]
  });
  const rawPath = path.join(runDir, `${roundId}-raw-response.json`);
  await fs.writeFile(rawPath, JSON.stringify({
    ok: true,
    roundId,
    model: response.model || config.model,
    createdAt: new Date().toISOString(),
    content: response.content,
    usage: response.raw?.usage || null
  }, null, 2), 'utf8');
  let parsed;
  try {
    parsed = parseJsonObject(response.content);
  } catch (error) {
    parsed = await recoverJsonObjectWithModel({
      config,
      fetchImpl,
      onProgress,
      invalidContent: response.content,
      modeLabel: roundId,
      schemaHint
    });
  }
  const parsedPath = path.join(runDir, `${roundId}.json`);
  await fs.writeFile(parsedPath, JSON.stringify(parsed, null, 2), 'utf8');
  onProgress?.({
    phase: 'ai:round:done',
    message: `AI 多轮验收：完成 ${roundId}`,
    roundId,
    outputPath: parsedPath,
    issueCount: Array.isArray(parsed?.issues) ? parsed.issues.length : 0
  });
  return {
    model: response.model || config.model,
    usage: response.raw?.usage || null,
    parsed,
    rawPath,
    parsedPath,
    requestPath
  };
}

async function callButtonHtmlRound({
  config,
  fetchImpl,
  onProgress,
  runDir,
  roundId,
  roundTitle,
  targetLabel,
  buttonStandards,
  buttonAuditFacts,
  buttonRoleGuide,
  htmlSnapshot,
  screenshotDataUrl
}) {
  const requestPath = path.join(runDir, `${roundId}-request.json`);
  const schemaHint = buttonRoundSchemaHint();
  const trimmedHtmlSnapshot = String(htmlSnapshot || '').slice(0, 12000);
  const systemText = [
    '你是 UXChecker 的按钮专项验收分析员。',
    `你当前只负责一个按钮专项分轮：${roundTitle}。`,
    '只检查按钮，不检查布局、表格、输入框、品牌和页面文案。',
    '你要先判断每个候选按钮更接近哪种按钮角色，再判断它是否符合该角色规范。',
    '不要写自然语言段落，不要写解释，不要写前后缀，只允许填写模板字段。',
    '如果没有明确问题，issues 可以为空数组。',
    'location 一定要带“代码位置（...）”。',
    'problem 一定写成“当前XXX，应该XXX；当前XXX，应该XXX”的句式。',
    '输出必须是严格 JSON。'
  ].join('\n');

  const userParts = [
    {
      type: 'text',
      text: [
        `本轮目标：${targetLabel || '按钮专项验收'}`,
        '',
        '按钮角色判断指南：',
        JSON.stringify(buttonRoleGuide || {}, null, 2),
        '',
        '按钮规范：',
        JSON.stringify(buttonStandards, null, 2),
        '',
        '本轮候选按钮事实（这是本轮的主要判断依据）：',
        JSON.stringify(buttonAuditFacts || {}, null, 2),
        '',
        '页面冻结后的运行态 HTML 片段（仅作补充上下文，不要把无关节点当作本轮目标）：',
        trimmedHtmlSnapshot,
        '',
        '请输出 JSON：',
        JSON.stringify(schemaHint, null, 2)
      ].join('\n')
    }
  ];

  if (screenshotDataUrl) {
    userParts.push({
      type: 'image_url',
      image_url: { url: screenshotDataUrl }
    });
  }

  await fs.writeFile(requestPath, JSON.stringify({
    roundId,
    mode: 'button-html-snapshot',
    system: systemText,
    targetLabel,
    schemaHint,
    htmlSnapshotBytes: Buffer.byteLength(String(trimmedHtmlSnapshot || ''), 'utf8'),
    buttonCount: Number(buttonAuditFacts?.buttonCount || 0),
    groupCount: Number(buttonAuditFacts?.groupCount || 0)
  }, null, 2), 'utf8');

  const response = await callModel({
    ...DEFAULT_CONFIG,
    ...config,
    fetchImpl,
    onProgress,
    temperature: config.temperature,
    maxTokens: 3200,
    messages: [
      { role: 'system', content: systemText },
      { role: 'user', content: userParts }
    ]
  });

  const rawPath = path.join(runDir, `${roundId}-raw-response.json`);
  await fs.writeFile(rawPath, JSON.stringify({
    ok: true,
    roundId,
    model: response.model || config.model,
    createdAt: new Date().toISOString(),
    content: response.content,
    usage: response.raw?.usage || null
  }, null, 2), 'utf8');

  let parsed;
  try {
    parsed = parseJsonObject(response.content);
  } catch (error) {
    parsed = await recoverJsonObjectWithModel({
      config,
      fetchImpl,
      onProgress,
      invalidContent: response.content,
      modeLabel: roundId,
      schemaHint
    });
  }

  const parsedPath = path.join(runDir, `${roundId}.json`);
  await fs.writeFile(parsedPath, JSON.stringify(parsed, null, 2), 'utf8');
  return {
    model: response.model || config.model,
    usage: response.raw?.usage || null,
    parsed,
    rawPath,
    parsedPath,
    requestPath
  };
}

async function runAiUxAnalysisMultiRound({
  config,
  runtime,
  audit,
  standards,
  multiroundProfile = null,
  skillDir,
  skillMeta,
  runDir,
  fetchImpl,
  onProgress
}) {
  const evidence = buildEvidencePayload(runtime, audit);
  const aiEvidencePath = path.join(runDir, 'ai-evidence.json');
  await fs.writeFile(aiEvidencePath, JSON.stringify(evidence, null, 2), 'utf8');

  const passes = buildRoundPlan(runtime, audit, multiroundProfile);
  const auditPlanPath = path.join(runDir, 'audit-plan.json');
  const runId = path.basename(runDir);
  const auditPlan = buildAuditPlanDocument({
    runId,
    mode: 'dom',
    selectedSkin: standards.selectedSkin || {
      id: String(skillMeta.skinId || ''),
      name: String(skillMeta.skinName || skillMeta.name || '')
    },
    passes
  });
  await writeAuditPlan(auditPlanPath, auditPlan);
  onProgress?.({
    phase: 'ai:plan:ready',
    message: `AI 验收计划已生成：${auditPlan.steps.length} 个步骤`,
    auditPlanPath,
    totalRounds: auditPlan.steps.length
  });

  const roundOutputs = [];
  const allIssues = [];
  const hasButtonPass = passes.some((pass) => {
    const checks = Array.isArray(pass.checks) ? pass.checks : [];
    return checks.includes('button-components') || checks.includes('button-group-components');
  });
  const domSnapshot = hasButtonPass ? await readDomSnapshotForAi(runtime, 50000) : '';
  const screenshotDataUrl = hasButtonPass ? await readBinaryAsDataUrl(runtime?.screenshot || '', 'image/png') : '';
  const buttonStandards = pickButtonStandardsForAi(standards);

  for (const pass of passes) {
    const roundTitle = `${passDimensionName(pass.passId)} · ${roundTypeLabel(pass.targetType, pass.checks)} 第 ${roundOutputs.length + 1} 轮`;
    const checkedItems = Array.isArray(pass.checks) ? pass.checks : [];
    const roundEvidence = buildEvidencePayload(runtime, audit, checkedItems, pass.targetFilter || null);
    const buttonAuditFacts = buildButtonAuditFacts(roundEvidence, pass.targetLabel || '');
    const buttonRoleGuide = buildButtonRoleGuide();
    const evidenceStats = buildEvidenceStats(roundEvidence);
    const roundEvidencePath = path.join(runDir, `${pass.roundId}-evidence.json`);
    const buttonFactsPath = path.join(runDir, `${pass.roundId}-button-facts.json`);
    await fs.writeFile(roundEvidencePath, JSON.stringify(roundEvidence, null, 2), 'utf8');
    await fs.writeFile(buttonFactsPath, JSON.stringify(buttonAuditFacts, null, 2), 'utf8');
    onProgress?.({
      phase: 'ai:round:plan',
      message: `AI 多轮验收：${roundTitle}，目标 ${pass.targetLabel || checkedItems.map(toCheckLabel).join(' / ')}；按钮 ${buttonAuditFacts.buttonCount} 个，按钮组 ${buttonAuditFacts.groupCount} 个`,
      roundId: pass.roundId,
      checkedItems,
      buttonFactsPath,
      buttonCount: buttonAuditFacts.buttonCount,
      groupCount: buttonAuditFacts.groupCount,
      evidenceStats,
      targetLabel: pass.targetLabel || ''
    });
    await updateAuditPlan(auditPlanPath, (plan) => {
      const steps = Array.isArray(plan.steps) ? plan.steps : [];
      for (const step of steps) {
        if (step.id === pass.roundId) {
          step.status = 'running';
        } else if (step.status !== 'done' && step.status !== 'failed') {
          step.status = 'pending';
        }
      }
      return {
        ...plan,
        status: 'running',
        currentStep: steps.findIndex((step) => step.id === pass.roundId) + 1,
        steps
      };
    });
    const isButtonPass = checkedItems.includes('button-components') || checkedItems.includes('button-group-components');
    const round = isButtonPass
      ? await callButtonHtmlRound({
        config,
        fetchImpl,
        onProgress,
        runDir,
        roundId: pass.roundId,
        roundTitle,
        targetLabel: pass.targetLabel || '',
        buttonStandards,
        buttonAuditFacts,
        buttonRoleGuide,
        htmlSnapshot: domSnapshot,
        screenshotDataUrl
      })
      : await callJsonModelRound({
        config,
        fetchImpl,
        onProgress,
        runDir,
        roundId: pass.roundId,
        maxTokens: 3200,
        temperature: config.temperature,
        schemaHint: {
          summary: 'string',
          checkedItems: ['string'],
          targetLabel: 'string',
          targetType: 'string',
          evidenceStats: {
            elementCount: 'number',
            buttonCount: 'number',
            inputCount: 'number',
            selectCount: 'number',
            actionGroupCount: 'number',
            horizontalGapCount: 'number',
            verticalGapCount: 'number'
          },
          issues: [{
            severity: 'string',
            severityLabel: 'string',
            title: 'string',
            subject: 'string',
            location: 'string',
            actual: 'string',
            standard: 'string',
            suggestion: 'string',
            description: 'string',
            delta: 'string',
            sourcePass: 'string',
            sourceDimension: 'string'
          }],
          components: [{
            name: 'string',
            status: 'string',
            actual: 'string',
            standard: 'string',
            suggestion: 'string'
          }],
          limitations: ['string']
        },
        systemLines: [
          '你是 UXChecker 的公司 UI 规范组件专项验收分析员。',
          `你当前只负责一个分轮：${roundTitle}，不允许输出跨轮次笼统总结。`,
          '不要按品牌、产品名、标题、logo 文案评分。',
          'DOM/运行态证据按真实 CSS px 严格判断，标准值必须精确匹配。',
          '如果没有发现问题，也要在 summary 里明确写“本轮目标未发现问题”。',
          '每个问题都必须给出 subject、location、actual、standard、suggestion、delta。',
          '输出严格 JSON，不要 markdown。'
        ],
        userPayload: {
          task: `执行 ${pass.roundId}。${pass.purpose}`,
          roundTitle,
          checkedItems,
          targetLabel: pass.targetLabel || '',
          targetType: pass.targetType || '',
          selectedSkin: standards.selectedSkin || {
            id: String(skillMeta.skinId || ''),
            name: String(skillMeta.skinName || skillMeta.name || '')
          },
          targetFilter: pass.targetFilter || null,
          evidenceStats,
          outputLimits: {
            maxIssues: pass.maxIssues,
            format: '只输出一个可 JSON.parse 的 JSON object'
          },
          standards: pickStandardsSubsetForChecks(standards, checkedItems),
          evidence: roundEvidence,
          deterministicAudit: safeAuditForModel(audit)
        }
      });

    const normalizedRoundParsed = isButtonPass
      ? convertButtonRoundResultToIssues(round.parsed, pass.passId)
      : round.parsed;
    const parsedIssues = (Array.isArray(normalizedRoundParsed?.issues) ? normalizedRoundParsed.issues : [])
      .map((issue, index) => normalizeAiIssue(issue, pass.passId, index));
    allIssues.push(...parsedIssues);
    roundOutputs.push({
      passId: pass.passId,
      roundId: pass.roundId,
      roundTitle,
      checkedItems: Array.isArray(normalizedRoundParsed?.checkedItems) && normalizedRoundParsed.checkedItems.length
        ? normalizedRoundParsed.checkedItems
        : checkedItems,
      targetLabel: normalizedRoundParsed?.targetLabel || pass.targetLabel || '',
      targetType: normalizedRoundParsed?.targetType || pass.targetType || '',
      evidenceStats: normalizedRoundParsed?.evidenceStats || evidenceStats,
      summary: normalizedRoundParsed?.summary || '',
      issues: parsedIssues,
      components: Array.isArray(normalizedRoundParsed?.components) ? normalizedRoundParsed.components : [],
      limitations: Array.isArray(normalizedRoundParsed?.limitations) ? normalizedRoundParsed.limitations : [],
      rawPath: round.rawPath,
      parsedPath: round.parsedPath
    });
    onProgress?.({
      phase: 'ai:round:done',
      message: `AI 多轮验收：完成 ${roundTitle}${parsedIssues.length === 0 ? '，未发现问题' : `，发现 ${parsedIssues.length} 条问题`}`,
      roundId: pass.roundId,
      checkedItems: Array.isArray(normalizedRoundParsed?.checkedItems) && normalizedRoundParsed.checkedItems.length
        ? normalizedRoundParsed.checkedItems
        : checkedItems,
      targetLabel: normalizedRoundParsed?.targetLabel || pass.targetLabel || '',
      targetType: normalizedRoundParsed?.targetType || pass.targetType || '',
      evidenceStats: normalizedRoundParsed?.evidenceStats || evidenceStats,
      issueCount: parsedIssues.length,
      summary: normalizedRoundParsed?.summary || ''
    });
    await updateAuditPlan(auditPlanPath, (plan) => {
      const steps = Array.isArray(plan.steps) ? plan.steps : [];
      const target = steps.find((step) => step.id === pass.roundId);
      if (target) {
        target.status = 'done';
        target.issueCount = parsedIssues.length;
        target.checkedItems = checkedItems;
      }
      return {
        ...plan,
        status: 'running',
        currentStep: target ? target.order : plan.currentStep,
        steps
      };
    });
  }

  const mergedIssues = dedupeAiIssues(allIssues);
  await updateAuditPlan(auditPlanPath, (plan) => {
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    for (const step of steps) {
      if (step.id === 'summary-pass') {
        step.status = 'running';
      }
    }
    return {
      ...plan,
      status: 'running',
      currentStep: steps.findIndex((step) => step.id === 'summary-pass') + 1,
      steps
    };
  });
  const summaryRound = await callJsonModelRound({
    config,
    fetchImpl,
    onProgress,
    runDir,
    roundId: 'summary-pass',
    maxTokens: 3600,
    temperature: config.temperature,
    schemaHint: {
      score: 'number',
      stars: 'string',
      summary: 'string',
      issues: [{ severity: 'string', severityLabel: 'string', title: 'string', description: 'string', delta: 'string' }],
      dimensions: [{ name: 'string', score: 'number', max: 'number' }],
      components: [{ name: 'string', status: 'string', actual: 'string', standard: 'string', suggestion: 'string' }],
      limitations: ['string']
    },
    systemLines: [
      '你是 UXChecker 的最终汇总分析员。',
      '你会基于各分轮问题清单汇总最终报告。',
      '不要丢掉独立问题；允许同一页面存在多条不同按钮间距问题。',
      '不要重新发明新问题，只能基于已给出的分轮结果汇总、去重和评分。',
      '如果同一轮或不同轮已经明确列出了多条独立问题，最终报告必须尽量保留，不要过度压缩成少数几条。',
      '输出严格 JSON，不要 markdown。'
    ],
    userPayload: {
      task: '汇总多轮验收结果，生成最终总分、星级、维度分、主要问题和组件明细。',
      selectedSkin: standards.selectedSkin || {
        id: String(skillMeta.skinId || ''),
        name: String(skillMeta.skinName || skillMeta.name || '')
      },
      deterministicAudit: safeAuditForModel(audit),
      roundResults: roundOutputs.map((round) => ({
        passId: round.passId,
        roundId: round.roundId,
        roundTitle: round.roundTitle,
        checkedItems: round.checkedItems,
        targetLabel: round.targetLabel,
        targetType: round.targetType,
        evidenceStats: round.evidenceStats,
        summary: round.summary,
        issueCount: round.issues.length,
        issues: round.issues,
        components: round.components,
        limitations: round.limitations
      })),
      mergedIssuePool: mergedIssues.slice(0, 120),
      outputLimits: {
        maxIssues: 60,
        maxComponents: 24,
        maxSummaryChars: 260
      }
    }
  });

  const finalAnalysis = {
    ...summaryRound.parsed,
    issues: Array.isArray(summaryRound.parsed?.issues) && summaryRound.parsed.issues.length
      ? summaryRound.parsed.issues.map((issue, index) => normalizeAiIssue(issue, issue.sourcePass || 'summary-pass', index))
      : mergedIssues.slice(0, 60),
    components: Array.isArray(summaryRound.parsed?.components) && summaryRound.parsed.components.length
      ? summaryRound.parsed.components
      : mergePassComponents(roundOutputs).slice(0, 24),
    limitations: Array.isArray(summaryRound.parsed?.limitations)
      ? Array.from(new Set([
        ...summaryRound.parsed.limitations,
        ...roundOutputs.flatMap((round) => round.limitations || [])
      ]))
      : Array.from(new Set(roundOutputs.flatMap((round) => round.limitations || []))),
    rounds: roundOutputs.map((round) => ({
      passId: round.passId,
      roundId: round.roundId,
      roundTitle: round.roundTitle,
      checkedItems: round.checkedItems,
      targetLabel: round.targetLabel,
      targetType: round.targetType,
      evidenceStats: round.evidenceStats,
      summary: round.summary,
      issueCount: round.issues.length,
      parsedPath: round.parsedPath
    }))
  };

  const out = {
    ok: true,
    provider: config.provider || 'kimi',
    model: summaryRound.model || config.model,
    createdAt: new Date().toISOString(),
    analysis: finalAnalysis,
    aiEvidencePath,
    auditPlanPath,
    rawResponsePath: summaryRound.rawPath,
    usage: summaryRound.usage || null,
    rounds: roundOutputs.map((round) => ({
      passId: round.passId,
      roundId: round.roundId,
      roundTitle: round.roundTitle,
      checkedItems: round.checkedItems,
      targetLabel: round.targetLabel,
      targetType: round.targetType,
      evidenceStats: round.evidenceStats,
      parsedPath: round.parsedPath,
      rawPath: round.rawPath,
      issueCount: round.issues.length
    }))
  };
  const outPath = path.join(runDir, 'ai-analysis.json');
  await fs.writeFile(outPath, JSON.stringify(out, null, 2), 'utf8');
  await updateAuditPlan(auditPlanPath, (plan) => {
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    const target = steps.find((step) => step.id === 'summary-pass');
    if (target) {
      target.status = 'done';
      target.issueCount = Array.isArray(finalAnalysis.issues) ? finalAnalysis.issues.length : 0;
    }
    return {
      ...plan,
      status: 'completed',
      currentStep: steps.length,
      result: {
        score: finalAnalysis.score,
        stars: finalAnalysis.stars,
        issueCount: Array.isArray(finalAnalysis.issues) ? finalAnalysis.issues.length : 0
      },
      steps
    };
  });
  return {
    analysis: finalAnalysis,
    aiAnalysisPath: outPath,
    aiEvidencePath,
    auditPlanPath,
    rawResponsePath: summaryRound.rawPath,
    model: out.model,
    usage: out.usage
  };
}

export async function runAiUxAnalysis({ config, runtime, audit, skillDir, skillMeta = {}, runDir, fetchImpl, onProgress }) {
  onProgress?.({ phase: 'ai:evidence:start', message: '正在读取 Skill 规范并整理 DOM 安全证据' });
  const standards = await loadVisualStandards(skillDir, skillMeta);
  const multiroundProfile = await loadMultiroundProfile(skillDir);
  if (standards?.standardsVersion === 'multiskin' && multiroundProfile?.passes?.length) {
    onProgress?.({
      phase: 'ai:multiround:prepare',
      message: `检测到多皮肤规范，启动 ${buildRoundPlan(runtime, audit, multiroundProfile).length} 轮 AI 验收`,
      totalRounds: buildRoundPlan(runtime, audit, multiroundProfile).length
    });
    return runAiUxAnalysisMultiRound({
      config,
      runtime,
      audit,
      standards,
      multiroundProfile,
      skillDir,
      skillMeta,
      runDir,
      fetchImpl,
      onProgress
    });
  }

  const evidence = buildEvidencePayload(runtime, audit);
  const aiEvidencePath = path.join(runDir, 'ai-evidence.json');
  await fs.writeFile(aiEvidencePath, JSON.stringify(evidence, null, 2), 'utf8');
  const evidenceStat = await fs.stat(aiEvidencePath);
  onProgress?.({
    phase: 'ai:evidence:done',
    message: `DOM 模型证据已生成：${Math.round(evidenceStat.size / 1024)}KB`,
    bytes: evidenceStat.size,
    aiEvidencePath
  });
  const messages = [
    {
      role: 'system',
      content: [
        '你是 UXChecker 的公司 UI 规范验收分析员。',
        '你必须基于安全视觉证据 JSON、元素 bbox、computed style、元素关系和 PaletX 规范进行判断。',
        '不要按品牌、产品名、标题、logo 文案评分。只看颜色、尺寸、间距、圆角、字体、布局、状态、组件表现。',
        '必须区分证据模式：DOM/运行态证据按真实 CSS px 严格判断，标准 8px 时实测 10px 或 6px 都是不符合；只有截图/纯视觉降级模式才允许 ±2px 估算容差。',
        '如果本次选择了具体皮肤包，则皮肤 tokens、字体基线和 AI 增量规范优先级高于通用浅色 default 经验。',
        '证据已脱敏：正文、表格数据、输入内容、长文本和敏感格式不会提供。不要要求原始文字，也不要分析新闻、热搜、业务正文等内容。',
        '定位问题必须使用 region、type、label、box 坐标、selectorHash 等安全字段描述到具体元素，不要泛泛说“按钮不符合”。',
        '如果证据不足，不要编造；写入 limitations。',
        '输出必须是严格 JSON，不要 markdown。'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: '生成 UX 还原验收报告分析。当前 deterministicAudit 是基础规则结果，请结合规范和证据补充更细的问题、分数、结论。',
        requiredOutputSchema: {
          score: '0-100 number',
          stars: '★★★★★/★★★★☆/★★★☆☆/★★☆☆☆/★☆☆☆☆',
          summary: '中文总体结论，80-200字',
          issues: [
            {
              severity: 'severe|medium|minor',
              severityLabel: '严重|中等|轻微',
              title: '必须包含具体位置或元素文案',
              description: '必须写实际值、标准值、差异和为什么不符合',
              delta: '例如 间距 16px，标准 8px，差异 +8px'
            }
          ],
          dimensions: [
            { name: '第一眼视觉一致性', score: 0, max: 20 },
            { name: '组件视觉规范', score: 0, max: 35 },
            { name: '布局与内容还原度', score: 0, max: 20 },
            { name: '状态与交互表现', score: 0, max: 15 },
            { name: '实现一致性风险', score: 0, max: 10 }
          ],
          components: [
            {
              name: '组件或布局项名称',
              status: '通过|轻微|中等|严重|需复核',
              actual: '实际表现',
              standard: '规范标准',
              suggestion: '修复建议'
            }
          ],
          limitations: ['检查限制']
        },
        outputLimits: {
          maxIssues: 10,
          maxComponents: 12,
          maxSummaryChars: 180,
          format: '只输出一个可被 JSON.parse 直接解析的 JSON object，不要注释、不要 markdown、不要尾随逗号'
        },
        selectedSkin: standards.selectedSkin || {
          id: String(skillMeta.skinId || ''),
          name: String(skillMeta.skinName || skillMeta.name || '')
        },
        standards,
        evidence
      })
    }
  ];

  const response = await callModel({
    ...DEFAULT_CONFIG,
    ...config,
    fetchImpl,
    onProgress,
    messages,
    temperature: config.temperature,
    maxTokens: 3800
  });
  const rawResponsePath = path.join(runDir, 'ai-raw-response.json');
  await fs.writeFile(rawResponsePath, JSON.stringify({
    ok: true,
    provider: config.provider || 'kimi',
    model: response.model || config.model,
    createdAt: new Date().toISOString(),
    content: response.content,
    usage: response.raw?.usage || null
  }, null, 2), 'utf8');
  let parsed;
  try {
    parsed = parseJsonObject(response.content);
  } catch (error) {
    try {
      parsed = await recoverJsonObjectWithModel({
        config,
        fetchImpl,
        onProgress,
        invalidContent: response.content,
        modeLabel: 'DOM 验收',
        schemaHint: {
          score: 'number',
          stars: 'string',
          summary: 'string',
          issues: [{ severity: 'string', severityLabel: 'string', title: 'string', description: 'string', delta: 'string' }],
          dimensions: [{ name: 'string', score: 'number', max: 'number' }],
          components: [{ name: 'string', status: 'string', actual: 'string', standard: 'string', suggestion: 'string' }],
          limitations: ['string']
        }
      });
    } catch (repairError) {
      throw new Error(`模型返回内容不是严格 JSON，原始回复已保存：${rawResponsePath}；${repairError?.message || error?.message || String(error)}`);
    }
  }
  const out = {
    ok: true,
    provider: config.provider || 'kimi',
    model: response.model || config.model,
    createdAt: new Date().toISOString(),
    analysis: parsed,
    aiEvidencePath,
    rawResponsePath,
    usage: response.raw?.usage || null
  };
  const outPath = path.join(runDir, 'ai-analysis.json');
  await fs.writeFile(outPath, JSON.stringify(out, null, 2), 'utf8');
  return { analysis: parsed, aiAnalysisPath: outPath, aiEvidencePath, rawResponsePath, model: out.model, usage: out.usage };
}

function imageMimeType(imagePath) {
  const extension = path.extname(imagePath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  return 'image/png';
}

async function loadLegacyVisualStandards(skillDir) {
  const standardsDir = path.join(skillDir, 'standards', 'paletx');
  return {
    scoring: await readIfExists(path.join(skillDir, 'framework/scoring/scoring-rules.md'), 4500),
    normalization: await readIfExists(path.join(skillDir, 'framework/methodology/screenshot-normalization.md'), 4500),
    layout: await readIfExists(path.join(standardsDir, 'visual-standards/layout.md'), 4500),
    button: await readIfExists(path.join(standardsDir, 'visual-standards/button.md'), 4500),
    table: await readIfExists(path.join(standardsDir, 'visual-standards/table.md'), 3500),
    input: await readIfExists(path.join(standardsDir, 'visual-standards/input.md'), 3500),
    tokens: await readIfExists(path.join(standardsDir, 'design-tokens.md'), 3500),
    standardsVersion: 'legacy',
    selectedSkin: null
  };
}

async function loadVisualStandards(skillDir, skillMeta = {}) {
  const multiSkinRoot = path.join(skillDir, 'standards');
  const hasMultiSkin = await readIfExists(path.join(multiSkinRoot, 'README.md'), 200);
  if (!hasMultiSkin) {
    return loadLegacyVisualStandards(skillDir);
  }

  const skinId = String(skillMeta.skinId || '').trim();
  const skinName = String(skillMeta.skinName || skillMeta.name || '').trim();
  const skinDir = skinId ? path.join(multiSkinRoot, 'skins', skinId) : '';
  const routing = await readJsonIfExists(path.join(multiSkinRoot, 'skins', 'skin-font-routing.json'), 4500);
  const familyMap = await readJsonIfExists(path.join(multiSkinRoot, 'skins', 'family-map.json'), 3000);
  const skinIndex = await readJsonIfExists(path.join(multiSkinRoot, 'skins', 'index.json'), 3000);
  const skinReadme = skinDir ? await readIfExists(path.join(skinDir, 'README.md'), 2600) : '';
  const skinTokens = skinDir ? await readJsonIfExists(path.join(skinDir, 'tokens.json'), 6000) : '';
  const skinTokensMd = skinDir ? await readIfExists(path.join(skinDir, 'tokens.md'), 2800) : '';
  const skinMetadata = skinDir ? await readJsonIfExists(path.join(skinDir, 'metadata.json'), 2200) : '';
  const aiSuperset = /^ai-/i.test(skinId);
  const typographyCandidate = aiSuperset || skinId === 'NIV' || skinId === 'default-largefont' ? '14px-base.md' : '12px-base.md';

  return {
    standardsVersion: 'multiskin',
    selectedSkin: {
      id: skinId,
      name: skinName
    },
    scoring: await readIfExists(path.join(skillDir, 'framework/scoring/scoring-rules.md'), 4500),
    normalization: await readIfExists(path.join(skillDir, 'framework/methodology/screenshot-normalization.md'), 4500),
    coreOverview: await readIfExists(path.join(multiSkinRoot, 'paletx-core', 'README.md'), 2600),
    coreSharedTokens: await readJsonIfExists(path.join(multiSkinRoot, 'paletx-core', 'shared-tokens-baseline.json'), 5000),
    layoutOverview: await readIfExists(path.join(multiSkinRoot, 'paletx-core', 'layout', 'README.md'), 2600),
    layoutRules: await readJsonIfExists(path.join(multiSkinRoot, 'paletx-core', 'layout', 'layout-rules.json'), 7000),
    button: await readIfExists(path.join(multiSkinRoot, 'paletx-core', 'components', 'button.md'), 4500),
    table: await readIfExists(path.join(multiSkinRoot, 'paletx-core', 'components', 'table.md'), 3500),
    input: await readIfExists(path.join(multiSkinRoot, 'paletx-core', 'components', 'input.md'), 3500),
    select: await readIfExists(path.join(multiSkinRoot, 'paletx-core', 'components', 'select.md'), 3200),
    switch: await readIfExists(path.join(multiSkinRoot, 'paletx-core', 'components', 'switch.md'), 3200),
    pagination: await readIfExists(path.join(multiSkinRoot, 'paletx-core', 'components', 'pagination.md'), 3200),
    tab: await readIfExists(path.join(multiSkinRoot, 'paletx-core', 'components', 'tab.md'), 3200),
    typographyOverview: await readIfExists(path.join(multiSkinRoot, 'typography', 'README.md'), 2200),
    typographyDetection: await readIfExists(path.join(multiSkinRoot, 'typography', 'typography-detection.md'), 3200),
    typographyBase: await readIfExists(path.join(multiSkinRoot, 'typography', typographyCandidate), 4200),
    typographyAiAdjustments: aiSuperset
      ? await readIfExists(path.join(multiSkinRoot, 'typography', 'ai-adjustments.md'), 2600)
      : '',
    fontFoundation: await readJsonIfExists(path.join(multiSkinRoot, 'typography', 'font-foundation.json'), 3500),
    skinRouting: routing,
    skinFamilyMap: familyMap,
    skinIndex,
    skinReadme,
    skinTokens,
    skinTokensMd,
    skinMetadata,
    aiOverview: aiSuperset
      ? await readIfExists(path.join(multiSkinRoot, 'paletx-ai', 'README.md'), 2600)
      : '',
    aiComponents: aiSuperset
      ? await readIfExists(path.join(multiSkinRoot, 'paletx-ai', 'components', 'README.md'), 2600)
      : ''
  };
}

export async function runAiImageUxAnalysis({
  config,
  imagePath,
  imageSize,
  originalImageSize = null,
  imageNormalization = null,
  skillDir,
  skillMeta = {},
  runDir,
  fetchImpl,
  onProgress
}) {
  const normalizedConfig = normalizeModelConfig(config);
  if (!normalizedConfig.enabled || !normalizedConfig.apiKey) {
    throw new Error('图片模式需要启用支持视觉输入的大模型，并在“文档/UXChecker-2/config/model-config.json”配置 API Key');
  }

  onProgress?.({ phase: 'image:standards:start', message: '正在读取图片验收 Skill 规范' });
  const standards = await loadVisualStandards(skillDir, skillMeta);
  onProgress?.({
    phase: 'image:standards:done',
    message: `图片验收规范读取完成：${Object.values(standards).filter(Boolean).length} 组`
  });
  onProgress?.({ phase: 'image:file:start', message: `正在读取图片文件：${path.basename(imagePath)}` });
  const imageBytes = await fs.readFile(imagePath);
  const mimeType = imageMimeType(imagePath);
  onProgress?.({
    phase: 'image:file:done',
    message: `图片读取完成：${Math.round(imageBytes.length / 1024)}KB，${mimeType}`,
    imageBytes: imageBytes.length,
    mimeType
  });
  onProgress?.({ phase: 'image:base64:start', message: '正在编码图片用于视觉模型请求' });
  const imageBase64 = imageBytes.toString('base64');
  onProgress?.({
    phase: 'image:base64:done',
    message: `图片编码完成：Base64 ${Math.round(Buffer.byteLength(imageBase64, 'utf8') / 1024)}KB`,
    base64Bytes: Buffer.byteLength(imageBase64, 'utf8')
  });
  const task = {
    task: '仅根据上传的页面截图，按照 PaletX Pro 公司 UI 规范生成 UX 视觉验收结果。',
    evidenceMode: 'image',
    selectedSkin: standards.selectedSkin || {
      id: String(skillMeta.skinId || ''),
      name: String(skillMeta.skinName || skillMeta.name || '')
    },
    image: {
      width: imageSize?.width || 0,
      height: imageSize?.height || 0,
      mimeType
    },
    originalImage: originalImageSize ? {
      width: originalImageSize.width || 0,
      height: originalImageSize.height || 0
    } : null,
    imageNormalization: imageNormalization || null,
    rules: [
      '这是纯截图视觉模式，不得声称读取了 DOM、computed style、CSS 或交互状态。',
      '截图测量的尺寸和间距允许 ±2px 视觉估算容差。例如标准 8px 时，6px 至 10px 均可判为视觉通过。',
      '无法确认 DPR 时，不要把 image px 直接当 CSS px；优先根据常见控件尺寸、页面比例和重复元素估算。',
      '若提供了 imageNormalization，说明当前送审图片是用于检测的归一化代理图；所有尺寸判断和 previewMarkers 坐标都必须基于代理图尺寸，不基于原始大图。',
      '本次验收必须以当前选中的皮肤包为最高优先级；如果皮肤 tokens 与通用规则冲突，始终以当前皮肤 tokens 为准。',
      '禁止把深色或 AI 皮肤误判成浅色 default。若 selectedSkin 为 ai-dark、indigo、fantasy-blue 等深色系，不得因为深色背景、透明组件底或深色框架本身扣分。',
      '只检查截图中实际出现的元素；不得因为缺少主按钮、表格、分页或某种组件而扣分。',
      '禁止根据品牌、产品名称、标题、logo 文案评分。',
      '问题必须定位到可见区域，例如“顶部工具栏右侧搜索框”“表格右下角分页第 2 与下一页按钮”。',
      `每个问题都必须给出 previewMarkers，使用当前图片像素坐标。图片宽 ${imageSize?.width || 0}px，高 ${imageSize?.height || 0}px。`,
      'previewMarkers 至少提供一个定位点，字段格式为 { "label": "1", "center": { "x": 123, "y": 456 } }。如坐标无法精确估计，也必须给出最接近的中心点；只要求靠近真实元素附近，不要求像素级精度。',
      '每个问题必须包含视觉估算实际值、规范值、差异及修复建议；证据不足则标记需复核。',
      '输出严格 JSON，不要 markdown。'
    ],
    requiredOutputSchema: {
      score: '0-100 number',
      stars: '★★★★★/★★★★☆/★★★☆☆/★★☆☆☆/★☆☆☆☆',
      summary: '中文总体结论，80-200字',
      issues: [{
        severity: 'severe|medium|minor',
        severityLabel: '严重|中等|轻微',
        title: '具体可见区域和元素',
        subject: '被判定的组件/区域名称',
        location: '在截图中的位置描述',
        actual: '实际视觉表现',
        standard: '对应规范',
        suggestion: '修复建议',
        description: '视觉估算实际值、标准值、差异、原因和修复建议',
        delta: '例如 视觉估算间距约 12px，标准 8px，超出 ±2px 容差',
        previewMarkers: [{
          label: '1',
          center: { x: 'number', y: 'number' }
        }]
      }],
      dimensions: [
        { name: '第一眼视觉一致性', score: 0, max: 20 },
        { name: '组件视觉规范', score: 0, max: 35 },
        { name: '布局与内容还原度', score: 0, max: 20 },
        { name: '状态与交互表现', score: 0, max: 15 },
        { name: '实现一致性风险', score: 0, max: 10 }
      ],
      components: [{
        name: '截图中实际识别到的组件或布局项',
        status: '通过|轻微|中等|严重|需复核',
        actual: '截图中的视觉表现',
        standard: 'PaletX 标准及 ±2px 视觉容差',
        suggestion: '修复建议'
      }],
      limitations: ['纯截图模式限制']
    },
    outputLimits: {
      maxIssues: 8,
      maxComponents: 10,
      maxSummaryChars: 160,
      format: '只输出一个可被 JSON.parse 直接解析的 JSON object'
    },
    standards
  };

  const isAnthropic = normalizedConfig.provider === 'kimi-coding-anthropic'
    || normalizedConfig.provider === 'anthropic-compatible';
  const imagePart = isAnthropic
    ? { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } }
    : { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } };
  const textPart = isAnthropic
    ? { type: 'text', text: JSON.stringify(task) }
    : { type: 'text', text: JSON.stringify(task) };
  const messages = [
    {
      role: 'system',
      content: '你是 UXChecker 的 PaletX 页面截图视觉验收分析员。必须严格遵守用户消息中的证据模式和输出 JSON 要求。'
    },
    {
      role: 'user',
      content: [imagePart, textPart]
    }
  ];

  const aiEvidencePath = path.join(runDir, 'ai-evidence.json');
  await fs.writeFile(aiEvidencePath, JSON.stringify({
    evidenceMode: 'image',
    selectedSkin: standards.selectedSkin || null,
    imageNormalization: imageNormalization || null,
    image: {
      fileName: path.basename(imagePath),
      width: imageSize?.width || 0,
      height: imageSize?.height || 0,
      mimeType,
      bytes: imageBytes.length
    },
    toleranceCssPx: 2,
    standardsIncluded: Object.keys(standards).filter((key) => Boolean(standards[key]))
  }, null, 2), 'utf8');
  onProgress?.({ phase: 'image:evidence:done', message: '图片模型证据摘要已写入磁盘', aiEvidencePath });

  const response = await callModel({
    ...normalizedConfig,
    fetchImpl,
    onProgress,
    messages,
    temperature: normalizedConfig.temperature,
    maxTokens: 4200
  });
  const rawResponsePath = path.join(runDir, 'ai-raw-response.json');
  await fs.writeFile(rawResponsePath, JSON.stringify({
    ok: true,
    provider: normalizedConfig.provider,
    model: response.model || normalizedConfig.model,
    createdAt: new Date().toISOString(),
    content: response.content,
    usage: response.raw?.usage || null
  }, null, 2), 'utf8');

  let analysis;
  onProgress?.({ phase: 'ai:parse:start', message: '正在解析模型返回的验收 JSON' });
  try {
    analysis = parseJsonObject(response.content);
  } catch (error) {
    try {
      analysis = await recoverJsonObjectWithModel({
        config: normalizedConfig,
        fetchImpl,
        onProgress,
        invalidContent: response.content,
        modeLabel: '图片验收',
        schemaHint: {
          score: 'number',
          stars: 'string',
          summary: 'string',
          issues: [{ severity: 'string', severityLabel: 'string', title: 'string', description: 'string', delta: 'string' }],
          dimensions: [{ name: 'string', score: 'number', max: 'number' }],
          components: [{ name: 'string', status: 'string', actual: 'string', standard: 'string', suggestion: 'string' }],
          limitations: ['string']
        }
      });
    } catch (repairError) {
      throw new Error(`视觉模型返回内容不是严格 JSON，原始回复已保存：${rawResponsePath}；${repairError?.message || error?.message || String(error)}`);
    }
  }
  onProgress?.({ phase: 'ai:parse:done', message: '模型验收 JSON 解析完成' });
  analysis = normalizeImageAnalysis(analysis, imageSize || {});

  const analysisPath = path.join(runDir, 'ai-analysis.json');
  await fs.writeFile(analysisPath, JSON.stringify({
    ok: true,
    evidenceMode: 'image',
    provider: normalizedConfig.provider,
    model: response.model || normalizedConfig.model,
    createdAt: new Date().toISOString(),
    analysis,
    aiEvidencePath,
    rawResponsePath,
    usage: response.raw?.usage || null
  }, null, 2), 'utf8');

  return {
    analysis,
    aiAnalysisPath: analysisPath,
    aiEvidencePath,
    rawResponsePath,
    model: response.model || normalizedConfig.model,
    provider: normalizedConfig.provider
  };
}
