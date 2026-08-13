import fs from 'node:fs/promises';
import path from 'node:path';

const SAFE_TEXT_TYPES = new Set([
  'button',
  'select',
  'pagination',
  'tab',
  'status',
  'menu'
]);

const STRUCTURAL_REGIONS = new Set([
  'topbar',
  'sidebar',
  'page-toolbar'
]);

const SAFE_STATUS_WORDS = new Set([
  '正常',
  '异常',
  '可用',
  '不可用',
  '运行中',
  '已停止',
  '启用',
  '禁用',
  '通过',
  '失败',
  '告警',
  '错误',
  '严重',
  '中等',
  '轻微'
]);

const SENSITIVE_TEXT_PATTERNS = [
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,
  /\b1[3-9]\d{9}\b/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /\b[A-Za-z0-9_-]{16,}\b/g
];

function scrubSensitiveText(value) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  for (const pattern of SENSITIVE_TEXT_PATTERNS) {
    text = text.replace(pattern, '[敏感文本]');
  }
  return text;
}

function safeText(element = {}) {
  const raw = scrubSensitiveText(element.text);
  if (!raw) return '';
  const type = element.auditType || element.type || '';
  const region = element.auditRegion || element.region || '';
  const isStructuralRegion = STRUCTURAL_REGIONS.has(region);

  if (type === 'input') return raw ? '[输入内容已脱敏]' : '';
  if (type === 'table') return '[表格内容已脱敏]';
  if (type === 'clickable') return '[可点击内容已脱敏]';
  if (type === 'status') {
    return SAFE_STATUS_WORDS.has(raw) ? raw : '[状态文本已脱敏]';
  }
  if (isStructuralRegion) return raw.slice(0, 24);
  if (type === 'button' || type === 'select' || type === 'pagination' || type === 'tab') {
    return raw.slice(0, 36);
  }
  if (type === 'menu') return '[导航文本已脱敏]';
  if (raw.length <= 8 && SAFE_TEXT_TYPES.has(type)) return raw;
  return '[业务文本已脱敏]';
}

function selectorHash(value) {
  const text = String(value || '');
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash) + text.charCodeAt(index);
    hash >>>= 0;
  }
  return `sel_${hash.toString(36)}`;
}

function safeBox(box = {}) {
  return {
    x: Math.round(Number(box.x) || 0),
    y: Math.round(Number(box.y) || 0),
    width: Math.round(Number(box.width) || 0),
    height: Math.round(Number(box.height) || 0)
  };
}

function safeStyle(style = {}) {
  return {
    color: style.color,
    backgroundColor: style.backgroundColor,
    borderColor: style.borderTopColor || style.borderColor,
    borderWidth: style.borderWidth,
    borderRadius: style.borderRadius,
    boxShadow: style.boxShadow,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    lineHeight: style.lineHeight,
    padding: style.padding,
    margin: style.margin,
    display: style.display,
    position: style.position,
    textAlign: style.textAlign,
    cursor: style.cursor,
    opacity: style.opacity
  };
}

function safeElement(element = {}, index = 0) {
  return {
    uid: `e${index + 1}`,
    type: element.auditType,
    region: element.auditRegion,
    label: safeText(element),
    selectorHash: selectorHash(element.selector),
    tagName: element.tagName,
    role: element.role,
    box: safeBox(element.box),
    style: safeStyle(element.style),
    states: {
      clickable: Boolean(element.clickable),
      focusable: Boolean(element.focusable),
      disabled: Boolean(element.disabled),
      checked: element.checked ?? null,
      selected: Boolean(element.selected)
    }
  };
}

function safeRegion(region = {}) {
  return {
    region: region.region,
    count: region.count,
    types: region.types || {},
    sample: (region.sample || []).slice(0, 8).map((item) => ({
      type: item.type,
      label: safeText({ auditType: item.type, auditRegion: region.region, text: item.text }),
      box: safeBox(item.box)
    }))
  };
}

function safeRelationRef(ref = {}) {
  return {
    type: ref.auditType,
    region: ref.auditRegion,
    label: safeText(ref),
    box: safeBox(ref.box)
  };
}

function safeHorizontalGap(relation = {}) {
  return {
    region: relation.region,
    from: safeRelationRef(relation.from),
    to: safeRelationRef(relation.to),
    gap: relation.gap,
    centerDeltaY: relation.centerDeltaY,
    verticalOverlap: relation.verticalOverlap
  };
}

function safeVerticalGap(relation = {}) {
  return {
    region: relation.region,
    from: safeRelationRef(relation.from),
    to: safeRelationRef(relation.to),
    gap: relation.gap,
    centerDeltaX: relation.centerDeltaX,
    horizontalOverlap: relation.horizontalOverlap
  };
}

function safeActionGroup(group = {}) {
  return {
    region: group.region,
    y: group.y,
    count: group.count,
    items: (group.items || []).slice(0, 16).map(safeRelationRef),
    gaps: (group.gaps || []).slice(0, 16)
  };
}

function viewportOf(runtime = {}) {
  return {
    width: runtime.viewport?.width,
    height: runtime.viewport?.height,
    devicePixelRatio: runtime.viewport?.devicePixelRatio,
    scrollX: runtime.viewport?.scrollX,
    scrollY: runtime.viewport?.scrollY
  };
}

export function buildSafeEvidence(runtime = {}) {
  const normalized = runtime.normalizedEvidence || {};
  const elements = normalized.elements || runtime.normalizedElements || [];
  const safeElements = elements.map(safeElement);

  return {
    schemaVersion: 'safe-evidence-v1',
    privacy: {
      policy: '仅包含 UI 视觉验收所需证据；正文、表格数据、输入值、长文本和敏感格式已脱敏。',
      rawEvidenceLocalOnly: true,
      textPolicy: {
        keep: '短按钮文案、短菜单/状态/Tab 文案',
        redact: '输入值、表格正文、业务正文、长文本、IP/手机号/邮箱/长 token'
      }
    },
    page: {
      titleKind: runtime.title ? 'present' : 'empty',
      urlKind: runtime.url ? 'present' : 'empty',
      viewport: viewportOf(runtime),
      pageStyle: runtime.pageStyle
    },
    skeleton: {
      rawElementCount: normalized.rawElementCount || runtime.elements?.length || safeElements.length,
      effectiveElementCount: normalized.effectiveElementCount || safeElements.length,
      typeCounts: normalized.typeCounts || {},
      regionCounts: normalized.regionCounts || {},
      regions: (normalized.regions || []).map(safeRegion)
    },
    elements: safeElements,
    relations: {
      horizontalGaps: (normalized.relations?.horizontalGaps || []).map(safeHorizontalGap),
      verticalGaps: (normalized.relations?.verticalGaps || []).map(safeVerticalGap),
      actionGroups: (normalized.relations?.actionGroups || []).map(safeActionGroup)
    }
  };
}

export function compactSafeEvidenceForAi(safeEvidence = {}) {
  const priorityTypes = new Set(['button', 'input', 'select', 'table', 'pagination', 'tab', 'status']);
  const priorityRegions = new Set(['page-toolbar', 'content', 'table-area']);
  const elements = [...(safeEvidence.elements || [])].sort((a, b) => {
    const pa = (priorityTypes.has(a.type) ? 0 : 1) + (priorityRegions.has(a.region) ? 0 : 1);
    const pb = (priorityTypes.has(b.type) ? 0 : 1) + (priorityRegions.has(b.region) ? 0 : 1);
    return pa - pb || (a.box?.y || 0) - (b.box?.y || 0) || (a.box?.x || 0) - (b.box?.x || 0);
  });

  const MAX_ELEMENTS = 70;
  const COVERAGE_TYPES = ['button', 'input', 'select', 'pagination', 'tab', 'status', 'table'];
  const selected = [];
  const selectedIds = new Set();

  for (const type of COVERAGE_TYPES) {
    const first = elements.find((element) => element.type === type);
    if (!first || selectedIds.has(first.uid)) continue;
    selected.push(first);
    selectedIds.add(first.uid);
  }

  for (const element of elements) {
    if (selected.length >= MAX_ELEMENTS) break;
    if (selectedIds.has(element.uid)) continue;
    selected.push(element);
    selectedIds.add(element.uid);
  }

  const compactElement = (element = {}) => ({
    uid: element.uid,
    type: element.type,
    region: element.region,
    label: element.label,
    selectorHash: element.selectorHash,
    tagName: element.tagName,
    role: element.role,
    box: element.box,
    style: {
      color: element.style?.color,
      backgroundColor: element.style?.backgroundColor,
      borderColor: element.style?.borderColor,
      borderWidth: element.style?.borderWidth,
      borderRadius: element.style?.borderRadius,
      boxShadow: element.style?.boxShadow,
      fontSize: element.style?.fontSize,
      fontWeight: element.style?.fontWeight,
      lineHeight: element.style?.lineHeight,
      padding: element.style?.padding,
      textAlign: element.style?.textAlign,
      opacity: element.style?.opacity
    },
    states: element.states
  });

  return {
    schemaVersion: safeEvidence.schemaVersion,
    privacy: safeEvidence.privacy,
    page: safeEvidence.page,
    skeleton: safeEvidence.skeleton,
    elements: selected.map(compactElement),
    relations: {
      horizontalGaps: (safeEvidence.relations?.horizontalGaps || []).slice(0, 70),
      verticalGaps: (safeEvidence.relations?.verticalGaps || []).slice(0, 45),
      actionGroups: (safeEvidence.relations?.actionGroups || []).slice(0, 25)
    }
  };
}

export async function writeSafeEvidence(runtime, outPath) {
  const safeEvidence = buildSafeEvidence(runtime);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(safeEvidence, null, 2), 'utf8');
  return safeEvidence;
}
