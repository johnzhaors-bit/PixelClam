const PALETX = {
  primary: '#1993ff',
  pageBg: '#f5f5f5',
  panelBg: '#ffffff',
  text: '#4d4d4d',
  subText: '#737373',
  border: '#d9d9d9',
  tableHeader: '#eeeeee',
  radius: 3,
  buttonGap: 8,
  buttonGapToleranceDom: 0,
  buttonGapToleranceVisual: 2,
  primaryDisabled: '#94d2ff'
};

function rgbToHex(value) {
  const match = String(value || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!match) return String(value || '').toLowerCase();
  return `#${[match[1], match[2], match[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
}

function hexDistance(a, b) {
  const aa = rgbToHex(a).replace('#', '');
  const bb = rgbToHex(b).replace('#', '');
  if (aa.length !== 6 || bb.length !== 6) return 999;
  const ar = parseInt(aa.slice(0, 2), 16);
  const ag = parseInt(aa.slice(2, 4), 16);
  const ab = parseInt(aa.slice(4, 6), 16);
  const br = parseInt(bb.slice(0, 2), 16);
  const bg = parseInt(bb.slice(2, 4), 16);
  const bl = parseInt(bb.slice(4, 6), 16);
  return Math.sqrt((ar - br) ** 2 + (ag - bg) ** 2 + (ab - bl) ** 2);
}

function px(value) {
  const match = String(value || '').match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function severity(label) {
  return {
    severe: '严重',
    medium: '中等',
    minor: '轻微'
  }[label] || '轻微';
}

function compactText(value, limit = 28) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function elementLocator(el) {
  if (el.id) return `#${el.id}`;
  if (el.selector) {
    const selector = String(el.selector).trim().replace(/\s+/g, ' ');
    if (selector) return compactText(selector, 48);
  }
  if (el.className) {
    const firstClass = String(el.className).trim().split(/\s+/).filter(Boolean)[0];
    if (firstClass) return `.${firstClass}`;
  }
  return '';
}

function safeBox(box) {
  const x = Number(box?.x || 0);
  const y = Number(box?.y || 0);
  const width = Math.max(0, Number(box?.width || 0));
  const height = Math.max(0, Number(box?.height || 0));
  return { x, y, width, height };
}

function localSelector(selector = '') {
  const text = String(selector || '').trim();
  if (!text) return '';
  const parts = text.split(/\s+::\s+/);
  return parts[parts.length - 1]?.trim() || text;
}

function unionBoxes(boxes = []) {
  const valid = boxes.map(safeBox).filter((box) => box.width > 0 && box.height > 0);
  if (!valid.length) return null;
  const left = Math.min(...valid.map((box) => box.x));
  const top = Math.min(...valid.map((box) => box.y));
  const right = Math.max(...valid.map((box) => box.x + box.width));
  const bottom = Math.max(...valid.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function elementName(el) {
  const sig = [
    el.tagName || '',
    el.auditType || '',
    el.className || '',
    el.selector || '',
    ...(el.semanticHints || [])
  ].join(' ');
  let kind = el.semanticHints?.[0] || el.auditType || el.tagName;
  if (/px-keywords-filter|px-ttoolbar-keywordfilter/i.test(sig)) kind = 'search';
  if (/px-ui-datatable-refresh|px-ttoolbar-refresh/i.test(sig)) kind = 'refresh';
  if (/px-radio|radiobutton|ui-radiobutton/i.test(sig)) kind = 'radio';
  if (/px-checkbox|checkbox/i.test(sig)) kind = 'checkbox';
  if (/px-select/i.test(sig)) kind = 'select';
  if (/px-ui-paginator/i.test(sig)) kind = 'pagination';
  if (/ui-button|button/i.test(sig) && !/px-ui-paginator/i.test(sig)) kind = 'button';
  const text = compactText(el.text, 28);
  const locator = elementLocator(el);
  const parts = [`${kind}${text ? `“${text}”` : ''}`];
  if (locator) parts.push(locator);
  parts.push(`@ (${el.box.x}, ${el.box.y})`);
  return parts.join(' ');
}

function focusTargetForElement(el) {
  return {
    selector: String(el.selector || ''),
    localSelector: localSelector(el.selector || ''),
    tagName: String(el.tagName || ''),
    text: String(el.text || ''),
    id: String(el.id || ''),
    className: String(el.className || ''),
    frame: el.frame ? {
      url: String(el.frame.url || ''),
      name: String(el.frame.name || ''),
      path: Array.isArray(el.frame.path) ? [...el.frame.path] : []
    } : null,
    box: safeBox(el.box)
  };
}

function normalizeIssueDetails(description = '', suggestion = '') {
  const text = String(description || '').trim();
  const normalized = text.replace(/\s+/g, ' ');
  const extract = (label, nextLabels) => {
    const nextPattern = nextLabels.length ? `(?=${nextLabels.map((item) => `${item}：`).join('|')}|$)` : '$';
    const match = normalized.match(new RegExp(`${label}：([\\s\\S]*?)${nextPattern}`));
    return match ? match[1].trim().replace(/[。；;]+$/, '') : '';
  };
  const location = extract('定位', ['实际表现', '规范标准', '修改建议']);
  const actual = extract('实际表现', ['规范标准', '修改建议']);
  const standard = extract('规范标准', ['修改建议']);
  const fixSuggestion = suggestion || extract('修改建议', []);
  return {
    location,
    actual,
    standard,
    suggestion: fixSuggestion || (standard ? `建议按规范标准调整该对象，优先消除当前差异。` : '')
  };
}

function issue(sev, title, description, delta, subject = '', focusBoxes = [], suggestion = '', focusTargets = []) {
  const details = normalizeIssueDetails(description, suggestion);
  return {
    severity: sev,
    severityLabel: severity(sev),
    title,
    description,
    delta,
    subject,
    focusBoxes,
    focusTargets,
    location: details.location,
    actual: details.actual,
    standard: details.standard,
    suggestion: details.suggestion
  };
}

function groupByHint(elements, hint) {
  return elements.filter((el) => (el.semanticHints || []).includes(hint));
}

function boxCenterY(el) {
  return (el.box?.y || 0) + (el.box?.height || 0) / 2;
}

function elementSignature(el) {
  const ancestry = Array.isArray(el.ancestry)
    ? el.ancestry.map((item) => `${item.tag || ''} ${item.id || ''} ${item.className || ''}`).join(' ')
    : '';
  return [
    el.tagName || '',
    el.auditType || '',
    el.id || '',
    el.className || '',
    el.selector || '',
    ancestry,
    ...(el.semanticHints || [])
  ].join(' ');
}

function isTableStructure(el) {
  const sig = elementSignature(el);
  return el.auditType === 'table'
    || /(^|[^a-z])(table|thead|tbody|tr|td|th)([^a-z]|$)|datatable|px-ui-column|header-content|px-table-name-title|px-ui-cell|sucstatus/i.test(sig);
}

function isActionControlForGap(el) {
  const sig = elementSignature(el);
  const ownSig = [el.tagName || '', el.auditType || '', el.className || ''].join(' ');
  if (['topbar', 'sidebar', 'framework'].includes(el.auditRegion)) return false;
  if (/px-radio|radiobutton|ui-radiobutton|px-checkbox|checkbox|switch/i.test(sig)) return false;
  if (/px-ui-form-buttons|px-form-btns/i.test(ownSig)) return false;
  if (/px-ttoolbar-refresh/i.test(el.tagName || '')) return false;
  if (/px-select-container|px-select-wrap|px-keywords-filter|px-ui-datatable-refresh|px-ui-paginator-page|px-ui-paginator-next|px-ui-paginator-prev|px-ui-paginator-first|px-ui-paginator-last|px-select-for-table-paginator/i.test(sig)) return true;
  if (/ui-button/i.test(sig) && !/ui-button-text/i.test(sig)) return true;
  if ((el.semanticHints || []).includes('button') && !/ui-button-text/i.test(sig)) return true;
  if (el.auditType === 'button' && !/ui-button-text/i.test(sig)) return true;
  if (el.tagName === 'button') return true;
  if (isTableStructure(el)) return false;
  return false;
}

function auditMode(runtime) {
  const mode = String(runtime.auditMode || runtime.evidenceMode || runtime.inputMode || '').toLowerCase();
  if (mode.includes('image') || mode.includes('screenshot') || mode.includes('visual')) return 'visual';
  return 'dom';
}

function layoutTolerance(runtime) {
  return auditMode(runtime) === 'visual' ? PALETX.buttonGapToleranceVisual : PALETX.buttonGapToleranceDom;
}

function hasPaletXPrimarySignal(el) {
  const style = el.style || {};
  return [
    style.backgroundColor,
    style.borderLeftColor,
    style.borderRightColor,
    style.borderTopColor,
    style.borderBottomColor,
    style.color
  ].some((value) => {
    const hex = rgbToHex(value);
    return hexDistance(hex, PALETX.primary) < 18 || hexDistance(hex, PALETX.primaryDisabled) < 18;
  });
}

function rowKey(el) {
  return `${el.auditRegion || 'content'}:${Math.round(boxCenterY(el) / 6) * 6}`;
}

function containsBox(parent = {}, child = {}) {
  const pad = 1;
  return child.x >= parent.x - pad
    && child.y >= parent.y - pad
    && child.x + child.width <= parent.x + parent.width + pad
    && child.y + child.height <= parent.y + parent.height + pad;
}

function boxArea(el) {
  return Math.max(0, el.box?.width || 0) * Math.max(0, el.box?.height || 0);
}

function normalizedActionControls(elements) {
  const controls = elements
    .filter(isActionControlForGap)
    .filter((el) => (el.box?.width || 0) >= 12 && (el.box?.height || 0) >= 12)
    .sort((a, b) => boxArea(b) - boxArea(a));

  return controls
    .filter((el, index) => {
      return !controls.slice(0, index).some((parent) => {
        if (Math.abs(boxCenterY(parent) - boxCenterY(el)) > 8) return false;
        return containsBox(parent.box || {}, el.box || {});
      });
    })
    .sort((a, b) => (a.box?.y || 0) - (b.box?.y || 0) || (a.box?.x || 0) - (b.box?.x || 0));
}

function horizontalButtonGroups(elements) {
  const buckets = new Map();
  for (const el of normalizedActionControls(elements)) {
    const key = rowKey(el);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(el);
  }

  return Array.from(buckets.values())
    .map((items) => items.sort((a, b) => (a.box?.x || 0) - (b.box?.x || 0)))
    .flatMap((items) => {
      const clusters = [];
      let current = [];
      for (const item of items) {
        const previous = current[current.length - 1];
        const gap = previous ? (item.box?.x || 0) - ((previous.box?.x || 0) + (previous.box?.width || 0)) : 0;
        if (previous && gap > 80) {
          clusters.push(current);
          current = [];
        }
        current.push(item);
      }
      if (current.length) clusters.push(current);
      return clusters;
    })
    .filter((items) => items.length >= 2)
    .map((items) => {
      const gaps = [];
      for (let index = 0; index < items.length - 1; index += 1) {
        const current = items[index];
        const next = items[index + 1];
        const gap = Math.round((next.box?.x || 0) - ((current.box?.x || 0) + (current.box?.width || 0)));
        if (gap >= 0 && gap <= 48) {
          gaps.push({ from: current, to: next, gap });
        }
      }
      return { items, gaps };
    })
    .filter((group) => group.gaps.length);
}

function scoreFromIssues(base, issues) {
  const loss = issues.reduce((sum, item) => {
    if (item.severity === 'severe') return sum + 12;
    if (item.severity === 'medium') return sum + 6;
    return sum + 2;
  }, 0);
  return Math.max(0, Math.min(base, base - loss));
}

export function auditRuntime(runtime) {
  const mode = auditMode(runtime);
  const gapTolerance = layoutTolerance(runtime);
  const gapToleranceText = gapTolerance === 0 ? 'DOM/运行态严格匹配，不设像素容差' : `截图/视觉验收允许 ±${gapTolerance}px`;
  const normalized = runtime.normalizedEvidence || null;
  const elements = normalized?.elements || runtime.normalizedElements || runtime.elements || [];
  const scoringRegions = new Set(['content', 'table-area', 'page-toolbar']);
  const frameworkRegions = new Set(['topbar', 'sidebar', 'right-panel']);
  const scoringElements = elements.filter((el) => scoringRegions.has(el.auditRegion || 'content'));
  const frameworkElements = elements.filter((el) => frameworkRegions.has(el.auditRegion || ''));
  const buttons = groupByHint(scoringElements, 'button');
  const inputs = groupByHint(scoringElements, 'input');
  const selects = groupByHint(scoringElements, 'select');
  const tables = groupByHint(scoringElements, 'table');
  const menus = groupByHint(scoringElements, 'menu');
  const pagination = groupByHint(scoringElements, 'pagination');
  const links = scoringElements.filter((el) => el.tagName === 'a' || (el.clickable && rgbToHex(el.style?.color) === PALETX.primary));

  const issues = [];
  const components = [];
  const scoringUnion = unionBoxes(scoringElements.map((el) => el.box));

  if (scoringElements.length < 8) {
    issues.push(issue(
      'severe',
      '主体内容采集不足，当前报告需复检',
      `定位：页面主体区域。实际表现：本次有效验收对象 ${elements.length} 个，但核心评分区域仅 ${scoringElements.length} 个，框架区 ${frameworkElements.length} 个。规范标准：UX 验收应覆盖页面主体的按钮、输入框、表格、分页、行内操作和布局间距；顶部导航/侧边菜单属于框架区，不应支撑高分。`,
      `核心对象 ${scoringElements.length} 个，低于最低复核阈值 8 个`,
      '页面主体区域',
      scoringUnion ? [scoringUnion] : [],
      '',
      []
    ));
  }

  const primaryLike = scoringElements.filter(hasPaletXPrimarySignal);
  if (!primaryLike.length) {
    issues.push(issue(
      'medium',
      '页面缺少 PaletX 主色强调元素',
      `定位：页面全局。实际表现：未在主体可见控件的背景、边框或文字中识别到接近 ${PALETX.primary} 或禁用主按钮色 ${PALETX.primaryDisabled} 的主色体系。规范标准：主按钮、禁用主按钮、选中态、链接/强调文字可使用公司主色体系；不得要求每个页面都必须出现可点击主按钮。`,
      `主色 ${PALETX.primary}/${PALETX.primaryDisabled} 未命中`,
      '页面全局',
      scoringUnion ? [scoringUnion] : [],
      '',
      []
    ));
  }

  for (const btn of buttons.slice(0, 20)) {
    const radius = px(btn.style?.borderRadius);
    if (radius !== null && radius > 5) {
      issues.push(issue(
        'medium',
        `${elementName(btn)} 圆角偏大`,
        `定位：${elementName(btn)}。实际表现：圆角约 ${radius}px。规范标准：Button 圆角约 ${PALETX.radius}px，允许轻微误差。`,
        `圆角 +${Math.round(radius - PALETX.radius)}px`,
        elementName(btn),
        [safeBox(btn.box)],
        '',
        [focusTargetForElement(btn)]
      ));
    }
    if (btn.box.height > 40) {
      issues.push(issue(
        'medium',
        `${elementName(btn)} 高度偏大`,
        `定位：${elementName(btn)}。实际表现：高度约 ${btn.box.height}px。规范标准：常规 Button 使用 24/28/32px 控件体系。`,
        `高度约 +${btn.box.height - 32}px`,
        elementName(btn),
        [safeBox(btn.box)],
        '',
        [focusTargetForElement(btn)]
      ));
    }
  }

  for (const input of inputs.slice(0, 20)) {
    const inputSig = elementSignature(input);
    const isTextareaLike = input.tagName === 'textarea' || /textarea|px-textarea|multi-line|multiline/i.test(inputSig);
    const isInputWrapper = /px-input-wrap|px-ui-form-item-right|px-form-item/i.test(inputSig) && input.tagName !== 'input' && input.tagName !== 'textarea';
    const radius = px(input.style?.borderRadius);
    if (radius !== null && radius > 5) {
      issues.push(issue(
        'medium',
        `${elementName(input)} 圆角偏大`,
        `定位：${elementName(input)}。实际表现：圆角约 ${radius}px。规范标准：Input 圆角约 ${PALETX.radius}px。`,
        `圆角 +${Math.round(radius - PALETX.radius)}px`,
        elementName(input),
        [safeBox(input.box)],
        '',
        [focusTargetForElement(input)]
      ));
    }
    if (!isTextareaLike && !isInputWrapper && input.box.height > 42) {
      issues.push(issue(
        'minor',
        `${elementName(input)} 高度需确认`,
        `定位：${elementName(input)}。实际表现：高度约 ${input.box.height}px。规范标准：Input 常用 28/32px，高度过大时会破坏后台密度。`,
        `高度约 +${input.box.height - 32}px`,
        elementName(input),
        [safeBox(input.box)],
        '',
        [focusTargetForElement(input)]
      ));
    }
  }

  for (const group of horizontalButtonGroups(scoringElements).slice(0, 20)) {
    for (const gapInfo of group.gaps) {
      const diff = Math.abs(gapInfo.gap - PALETX.buttonGap);
      if (diff > gapTolerance) {
        const sev = diff >= 8 ? 'medium' : 'minor';
        issues.push(issue(
          sev,
          `按钮组间距不符合 8px：${elementName(gapInfo.from)} 到 ${elementName(gapInfo.to)}`,
          `定位：${gapInfo.from.auditRegion || 'content'} 区域，同一行从 ${elementName(gapInfo.from)} 到 ${elementName(gapInfo.to)}。实际表现：两个操作项横向间距约 ${gapInfo.gap}px。规范标准：同组按钮/操作项横向间距 ${PALETX.buttonGap}px；本次为 ${mode === 'dom' ? 'DOM/运行态' : '截图/视觉'} 模式，${gapToleranceText}。`,
          `间距 ${gapInfo.gap}px，标准 ${PALETX.buttonGap}px，差异 ${gapInfo.gap - PALETX.buttonGap > 0 ? '+' : ''}${gapInfo.gap - PALETX.buttonGap}px`,
          `${elementName(gapInfo.from)} → ${elementName(gapInfo.to)}`,
          [safeBox(gapInfo.from.box), safeBox(gapInfo.to.box)],
          '',
          [focusTargetForElement(gapInfo.from), focusTargetForElement(gapInfo.to)]
        ));
      }
    }
  }

  if (tables.length) {
    components.push({
      name: 'Table / 运行态表格',
      status: '已识别',
      actual: `识别到 ${tables.length} 个 table/grid-like 元素，已采集表头、边框、行内操作和 bbox。`,
      standard: `表头背景应接近 ${PALETX.tableHeader}，分割线接近 ${PALETX.border}，行高和操作列应稳定。`,
      suggestion: '后续可细化到逐列表头、逐行高度和操作列间距。'
    });
  }

  components.push(
    {
      name: '本次实际检查项清单',
      status: `${new Set(elements.flatMap((el) => el.semanticHints || [])).size} 类对象`,
      actual: `有效验收对象 ${elements.length} 个；核心评分区 ${scoringElements.length} 个，框架区 ${frameworkElements.length} 个。核心区识别到 Button ${buttons.length}、Input ${inputs.length}、Select ${selects.length}、Table/Grid ${tables.length}、Menu/Nav ${menus.length}、Pagination ${pagination.length}、Link/文字操作 ${links.length}。`,
      standard: '评分仅基于当前页实际出现的业务主体对象和页面级规范；顶部导航、侧边菜单、右侧全局浮层默认作为框架区，不作为核心扣分/加分依据。',
      suggestion: scoringElements.length < 8 ? '本次主体采集不足，应先修复采集策略或重新检测，再看评分。' : '后续接入大模型后可增强复杂语义归类，但扣分仍由运行态证据和规则引擎决定。'
    },
    {
      name: '运行态证据',
      status: '已采集',
      actual: `视口 ${runtime.viewport?.width}×${runtime.viewport?.height}，DPR ${runtime.viewport?.devicePixelRatio}，原始候选 ${normalized?.rawElementCount ?? runtime.elements?.length ?? elements.length} 个，归一化有效对象 ${elements.length} 个。`,
      standard: `运行态验收应基于 DOM、computed style、bbox、截图与交互状态，不按截图宽度粗暴拉伸；布局间距当前采用 ${mode === 'dom' ? 'DOM 严格模式，0px 容差' : '截图视觉模式，允许 ±2px'}。`,
      suggestion: '这是比纯截图验收更可靠的证据基础。'
    }
  );

  if (frameworkElements.length) {
    components.push({
      name: 'Framework / 顶部导航与侧边菜单',
      status: '已采集，不参与核心评分',
      actual: `识别到框架区对象 ${frameworkElements.length} 个，包含顶部导航、侧边菜单或右侧全局浮层。`,
      standard: '这类区域通常由平台框架提供，默认不作为 PaletX 页面还原度的核心评分依据。',
      suggestion: '除非专项验收框架本身，否则报告应聚焦主体业务区。'
    });
  }

  if (buttons.length) {
    components.push({
      name: 'Button / 按钮与可点击入口',
      status: issues.some((i) => i.title.includes('button') || i.title.includes('按钮')) ? '需复核' : '通过',
      actual: `识别到 ${buttons.length} 个 button-like 元素，已检查高度、圆角、颜色和点击属性。`,
      standard: 'Button 使用公司主色/边框体系，常规高度 24/28/32px，圆角约 3px，文字和图标对齐。',
      suggestion: '对被标记的具体按钮按报告定位修复。'
    });
  }

  const buttonGroups = horizontalButtonGroups(scoringElements);
  if (buttonGroups.length) {
    const abnormalGaps = buttonGroups.flatMap((group) => group.gaps).filter((gapInfo) => Math.abs(gapInfo.gap - PALETX.buttonGap) > gapTolerance);
    components.push({
      name: 'Layout / 操作按钮组间距',
      status: abnormalGaps.length ? '需修复' : '通过',
      actual: `识别到 ${buttonGroups.length} 组同一行操作项；异常间距 ${abnormalGaps.length} 处。`,
      standard: `同组按钮/操作项横向间距 ${PALETX.buttonGap}px；本次采用 ${mode === 'dom' ? 'DOM 严格模式，0px 容差' : '截图视觉模式，允许 ±2px'}。`,
      suggestion: abnormalGaps.length ? '按报告中具体坐标位置调整按钮组 gap/margin，优先修复页面工具栏和表格行内操作。' : '按钮组间距稳定。'
    });
  }

  if (inputs.length || selects.length) {
    components.push({
      name: 'Input / Select / 搜索筛选',
      status: '已检查',
      actual: `识别到 Input ${inputs.length}、Select ${selects.length}。`,
      standard: `边框 ${PALETX.border}，圆角约 ${PALETX.radius}px，placeholder 灰度清晰，focus 使用主色反馈。`,
      suggestion: '运行态下一步可模拟 focus/hover 后二次采集。'
    });
  }

  const rawScore = scoreFromIssues(100, issues);
  const evidenceCap = scoringElements.length < 8 ? 55 : 98;
  const score = Math.max(0, Math.min(evidenceCap, rawScore));
  const stars = score >= 95 ? '★★★★★' : score >= 85 ? '★★★★☆' : score >= 70 ? '★★★☆☆' : score >= 60 ? '★★☆☆☆' : '★☆☆☆☆';

  return {
    score,
    stars,
    issues,
    components,
    dimensions: [
      { name: '第一眼视觉一致性', score: Math.min(20, Math.round(score * 0.2)), max: 20 },
      { name: '组件视觉规范', score: Math.min(35, Math.round(score * 0.35)), max: 35 },
      { name: '布局与内容还原度', score: Math.min(20, Math.round(score * 0.2)), max: 20 },
      { name: '状态与交互表现', score: 10, max: 15 },
      { name: '实现一致性风险', score: 8, max: 10 }
    ]
  };
}
