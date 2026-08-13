import fs from 'node:fs/promises';
import path from 'node:path';
import { callJsonModel } from './model-client.mjs';

export const DOM_ORIGIN_TEMPLATE = {
  components: [{
    componentFamily: 'string',
    status: 'present|not-present|uncertain',
    confidence: 'number 0-1',
    evidence: ['selector、标签或DOM路径']
  }],
  summary: '一句话'
};

const FAMILY_DOM_HINTS = {
  button: [/<button\b/i, /role=["']button["']/i, /class=["'][^"']*\b(?:btn|button)(?:\b|[-_])/i],
  input: [/<input\b/i, /<textarea\b/i, /class=["'][^"']*\binput(?:\b|[-_])/i],
  select: [/<select\b/i, /role=["'](?:combobox|listbox|option)["']/i, /class=["'][^"']*\bselect(?:\b|[-_])/i],
  checkbox: [/type=["']checkbox["']/i, /role=["']checkbox["']/i, /class=["'][^"']*\bcheckbox(?:\b|[-_])/i],
  radio: [/type=["']radio["']/i, /role=["']radio["']/i, /class=["'][^"']*\bradio(?:\b|[-_])/i],
  switch: [/role=["']switch["']/i, /class=["'][^"']*\bswitch(?:\b|[-_])/i],
  table: [/<table\b/i, /role=["'](?:table|grid|row|cell|columnheader)["']/i, /class=["'][^"']*\btable(?:\b|[-_])/i],
  'table-x': [/class=["'][^"']*\btable-x(?:\b|[-_])/i],
  pagination: [/class=["'][^"']*\b(?:pagination|pager)(?:\b|[-_])/i],
  menu: [/<(?:nav|menu)\b/i, /role=["'](?:menu|menubar|menuitem|navigation)["']/i, /class=["'][^"']*\bmenu(?:\b|[-_])/i],
  link: [/<a\b/i, /role=["']link["']/i],
  form: [/<form\b/i, /class=["'][^"']*\bform(?:\b|[-_])/i],
  tab: [/role=["'](?:tab|tablist|tabpanel)["']/i, /class=["'][^"']*\btab(?:\b|[-_])/i],
  card: [/class=["'][^"']*\bcard(?:\b|[-_])/i],
  toolbar: [/role=["']toolbar["']/i, /class=["'][^"']*\btoolbar(?:\b|[-_])/i],
  tree: [/role=["']tree(?:item)?["']/i, /class=["'][^"']*\btree(?:\b|[-_])/i],
  progress: [/<progress\b/i, /role=["']progressbar["']/i, /class=["'][^"']*\bprogress(?:\b|[-_])/i],
  loading: [/aria-busy=["']true["']/i, /class=["'][^"']*\bloading(?:\b|[-_])/i]
};

function selectorPresent(domSnapshot, selector) {
  const tokens = String(selector || '').match(/[.#]?[A-Za-z][A-Za-z0-9_-]*/g) || [];
  return tokens.some((token) => {
    const plain = token.replace(/^[.#]/, '');
    if (plain.length < 3) return false;
    const escaped = plain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:class|id)=["'][^"']*\\b${escaped}\\b`, 'i').test(domSnapshot)
      || new RegExp(`<${escaped}\\b`, 'i').test(domSnapshot);
  });
}

function hasDeterministicDomCandidate(entry, domSnapshot) {
  if ((FAMILY_DOM_HINTS[entry.componentFamily] || []).some((pattern) => pattern.test(domSnapshot))) return true;
  return entry.selectorAliases.some((selector) => selectorPresent(domSnapshot, selector));
}

function compactEvidence(domSnapshot, entries) {
  const keywords = new Set(entries.flatMap((entry) => [entry.componentFamily, ...entry.selectorAliases.flatMap((value) => String(value).match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || [])]));
  const nodes = [];
  for (const match of domSnapshot.matchAll(/<[^!][^>]*>/g)) {
    if ([...keywords].some((keyword) => match[0].toLowerCase().includes(keyword.toLowerCase()))) nodes.push(match[0]);
    if (nodes.join('\n').length > 120000) break;
  }
  return [...new Set(nodes)].join('\n');
}

export async function classifyDomComponentOrigins(options) {
  const domSnapshot = await fs.readFile(options.evidencePath, 'utf8');
  const entries = [];
  for (const standard of options.standards || []) {
    const parsed = JSON.parse(await fs.readFile(standard.standardPath, 'utf8'));
    entries.push({
      componentFamily: standard.componentFamily,
      displayName: parsed.component?.displayName || parsed.component?.name || standard.componentFamily,
      selectorAliases: parsed.detection?.selectorAliases || parsed.sourceResolvedStyle?.selectorAliases || []
    });
  }
  const candidates = entries.filter((entry) => hasDeterministicDomCandidate(entry, domSnapshot));
  const absent = entries.filter((entry) => !candidates.includes(entry));
  let response = { parsed: { components: [], summary: '' }, model: '', usage: null };
  if (candidates.length) {
    response = await callJsonModel({
      config: options.config,
      fetchImpl: options.fetchImpl,
      onProgress: options.onProgress,
      maxTokens: 3000,
      system: [
        '你是通用DOM组件盘点器，只判断页面是否出现组件族，不做视觉验收，不判断组件库来源。',
        '每个组件只能返回 present、not-present 或 uncertain。证据不足时返回 uncertain，避免漏检。',
        '不得读取或推断组件样式规范；只输出严格JSON。'
      ].join('\n'),
      userContent: JSON.stringify({ componentFamilies: candidates, domEvidence: compactEvidence(domSnapshot, candidates), requiredOutput: DOM_ORIGIN_TEMPLATE }),
      schemaHint: DOM_ORIGIN_TEMPLATE
    });
  }
  const returned = new Map((response.parsed?.components || []).map((item) => [String(item.componentFamily || ''), item]));
  const components = [
    ...candidates.map((entry) => {
      const item = returned.get(entry.componentFamily) || {};
      const status = ['present', 'not-present', 'uncertain'].includes(item.status) ? item.status : 'uncertain';
      const confidence = Math.max(0, Math.min(1, Number(item.confidence) || 0));
      const safelyAbsent = status === 'not-present' && confidence >= 0.9;
      return { componentFamily: entry.componentFamily, status: safelyAbsent ? 'not-present' : status === 'not-present' ? 'uncertain' : status, confidence, safelyAbsent, evidence: (item.evidence || []).map(String).slice(0, 8) };
    }),
    ...absent.map((entry) => ({ componentFamily: entry.componentFamily, status: 'not-present', confidence: 1, safelyAbsent: true, evidence: [] }))
  ];
  const result = {
    components,
    summary: String(response.parsed?.summary || '').slice(0, 160),
    skippedAbsentFamilies: components.filter((item) => item.safelyAbsent).map((item) => item.componentFamily),
    auditFamilies: components.filter((item) => !item.safelyAbsent).map((item) => item.componentFamily)
  };
  let resultPath = null;
  if (options.artifactDir) {
    resultPath = path.join(options.artifactDir, 'dom-component-inventory.json');
    await fs.writeFile(resultPath, `${JSON.stringify({ ...result, model: response.model, usage: response.usage }, null, 2)}\n`, 'utf8');
  }
  return { ...result, model: response.model, usage: response.usage, resultPath };
}
