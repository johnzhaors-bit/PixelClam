function area(box = {}) {
  return Math.max(0, Number(box.width) || 0) * Math.max(0, Number(box.height) || 0);
}

function textOf(element) {
  return String(element?.text || '').replace(/\s+/g, ' ').trim();
}

function looksLikeSelectControl(element) {
  const tag = String(element?.tagName || '').toLowerCase();
  const className = String(element?.className || '');
  const selector = String(element?.selector || '');
  const id = String(element?.id || '');
  const ownSignature = [tag, className, id].join(' ');
  const signature = [tag, className, selector, id].join(' ');
  const text = textOf(element);
  const hints = element?.semanticHints || [];

  if (['th', 'td', 'tr', 'thead', 'tbody', 'table', 'span'].includes(tag)) return false;
  const hasExplicitSelectMarker = /px-select|plx-select|select-container|select-wrap|select-first-child|singleSelectInputEllipsis|combobox|dropdown-trigger|dropdown-select/i.test(ownSignature);
  if (!hasExplicitSelectMarker && /px-ui-paginator-bottom|px-ui-widget-header|px-ui-sortable-column|px-td-too-long-text|px-ui-datatable-opt/i.test(signature)) {
    return false;
  }

  if (tag === 'select' || tag === 'px-select' || tag === 'plx-select') return true;
  if (element?.role && /combobox|listbox/i.test(String(element.role))) return true;
  if (/px-select-for-table-paginator|px-select-wrap|px-select-container|plx-select|combobox|dropdown-trigger|dropdown-select/i.test(ownSignature)) {
    return true;
  }
  if (/select-first-child|singleSelectInputEllipsis/i.test(ownSignature)) {
    return Boolean(text) && (Number(element?.box?.width) || 0) >= 48 && (Number(element?.box?.height) || 0) >= 20;
  }
  if (hints.includes('select') && /combobox|listbox/i.test(signature)) return true;

  return false;
}

function primaryHint(element) {
  const hints = element?.semanticHints || [];
  if (hints.includes('button')) return 'button';
  if (hints.includes('input')) return 'input';
  if (looksLikeSelectControl(element)) return 'select';
  if (hints.includes('table')) return 'table';
  if (hints.includes('pagination')) return 'pagination';
  if (hints.includes('tab')) return 'tab';
  if (hints.includes('status')) return 'status';
  if (hints.includes('menu')) return 'menu';
  if (hints.includes('clickable')) return 'clickable';
  return element?.tagName || 'unknown';
}

function ancestryText(element) {
  const ancestry = Array.isArray(element.ancestry) ? element.ancestry : [];
  return ancestry
    .map((item) => `${item.tag || ''} ${item.id || ''} ${item.className || ''}`)
    .join(' ');
}

function elementSignature(element) {
  return [
    element?.tagName || '',
    element?.id || '',
    element?.className || '',
    element?.selector || '',
    ancestryText(element)
  ].join(' ');
}

function isFrameworkElement(element) {
  const signature = elementSignature(element);
  return /ptl-header|ptl-top-nav|ptl-fat-navigation|ptl-fat-nav|ptl-app-search|ptl-msg|ptl-logo|ptl-sider|page-sidebar|plx-menu-container|plx-submenu|ptl-dropdown-content|notification|uep_ict_help_url/i.test(signature);
}

function isTopbarElement(element) {
  const signature = elementSignature(element);
  return /ptl-header|ptl-top-nav|ptl-logo|ptl-app-search|ptl-msg|uep_ict_help_url/i.test(signature);
}

function isSidebarElement(element) {
  const signature = elementSignature(element);
  return /ptl-sider|page-sidebar|plx-menu-container|plx-submenu|plx-menu-item/i.test(signature);
}

function isBusinessElement(element) {
  const signature = elementSignature(element);
  return /ptl-main|ptl-container|page-container|router-outlet|app-component-instance|app-component-instance-overview|mainContent|plx-tabset|plx-tab-content|plx-tab-pane|plx-nav-tabs|plx-nav-item|px-content-header|px-select|px-lazydatatable|px-editdatatable|px-ui-datatable|px-ttoolbar|px-keywords-filter|px-ttoolbar-refresh|px-ui-datatable-refresh|ui-button|px-ui-column|header-content|px-table-name-title|px-ui-cell|sucstatus|px-scroll-lazyDataTable|px-ui-paginator/i.test(signature);
}

function classifyRegion(element, viewport = {}) {
  const box = element.box || {};
  const width = Number(viewport.width) || 1440;
  const signature = elementSignature(element);
  if (isBusinessElement(element)) {
    if (/px-ui-datatable-refresh|px-ttoolbar-refresh|px-keywords-filter|px-ttoolbar|px-select|ui-button|plx-tab|px-content-header/i.test(signature) && box.y <= 220) return 'page-toolbar';
    if ((element.semanticHints || []).includes('table')) return 'table-area';
    if (box.y <= 220) return 'page-toolbar';
    return 'content';
  }
  if (isTopbarElement(element)) return 'topbar';
  if (isSidebarElement(element)) return 'sidebar';
  if (isFrameworkElement(element)) return 'framework';
  if (box.y <= 72 && box.height <= 96) return 'topbar';
  if (box.x <= 260 && box.y >= 40) return 'sidebar';
  if (box.x >= width - 380) return 'right-panel';
  if ((element.semanticHints || []).includes('table')) return 'table-area';
  if (box.y <= 180) return 'page-toolbar';
  return 'content';
}

function isLargeContainer(element, viewport = {}) {
  const box = element.box || {};
  const textLength = textOf(element).length;
  const pageArea = (Number(viewport.width) || 1440) * (Number(viewport.height) || 900);
  const type = primaryHint(element);
  const largeArea = area(box) > pageArea * 0.12;
  const longText = textLength > 120;
  const wideTextBar = box.width > (Number(viewport.width) || 1440) * 0.45 && textLength > 80;
  const preserve = ['table', 'input', 'select', 'button', 'pagination', 'tab', 'status'].includes(type);
  return !preserve && (largeArea || longText || wideTextBar);
}

function isUsefulElement(element, viewport = {}) {
  const box = element.box || {};
  if (!box.width || !box.height) return false;
  if (box.width < 4 || box.height < 4) return false;

  const type = primaryHint(element);
  const text = textOf(element);
  if (isLargeContainer(element, viewport)) return false;
  if (type === 'clickable' && !text && box.width < 16 && box.height < 16) return false;
  if (type === 'menu' && !text && !element.clickable) return false;
  if (text.length > 180 && !['table'].includes(type)) return false;
  return true;
}

function dedupeKey(element) {
  const box = element.box || {};
  return [
    primaryHint(element),
    Math.round((box.x || 0) / 2) * 2,
    Math.round((box.y || 0) / 2) * 2,
    Math.round((box.width || 0) / 2) * 2,
    Math.round((box.height || 0) / 2) * 2,
    textOf(element).slice(0, 48)
  ].join('|');
}

function containsBox(parent = {}, child = {}) {
  if (parent === child) return false;
  const tolerance = 2;
  return (
    (child.x || 0) >= (parent.x || 0) - tolerance &&
    (child.y || 0) >= (parent.y || 0) - tolerance &&
    (child.x || 0) + (child.width || 0) <= (parent.x || 0) + (parent.width || 0) + tolerance &&
    (child.y || 0) + (child.height || 0) <= (parent.y || 0) + (parent.height || 0) + tolerance
  );
}

function shouldDropAsParentContainer(element, candidates) {
  const type = primaryHint(element);
  if (['table', 'input', 'select', 'button', 'pagination', 'tab', 'status'].includes(type)) return false;
  const text = textOf(element);
  if (text.length < 24 && !['menu', 'clickable'].includes(type)) return false;
  const box = element.box || {};
  const contained = candidates.filter((candidate) => {
    if (candidate === element) return false;
    if (candidate.selector === element.selector) return false;
    if (!containsBox(box, candidate.box || {})) return false;
    const childType = primaryHint(candidate);
    return ['button', 'input', 'select', 'tab', 'pagination', 'status', 'menu', 'clickable'].includes(childType);
  });
  if (contained.length < 3) return false;

  const childArea = contained.reduce((sum, item) => sum + area(item.box), 0);
  const parentArea = area(box);
  const looksLikeWrapper = parentArea > 0 && childArea / parentArea > 0.08;
  return looksLikeWrapper || text.length > 80;
}

function compactElement(element, viewport) {
  return {
    ...element,
    auditType: primaryHint(element),
    auditRegion: classifyRegion(element, viewport),
    text: textOf(element).slice(0, 180)
  };
}

function countBy(elements, field) {
  const counts = {};
  for (const element of elements) {
    const value = element[field] || 'unknown';
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function buildRegionSummary(elements) {
  const grouped = new Map();
  for (const element of elements) {
    const key = element.auditRegion || 'unknown';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(element);
  }
  return Array.from(grouped, ([region, items]) => ({
    region,
    count: items.length,
    types: countBy(items, 'auditType'),
    sample: items.slice(0, 8).map((item) => ({
      type: item.auditType,
      text: item.text,
      box: item.box
    }))
  }));
}

function centerX(element) {
  return (element.box?.x || 0) + (element.box?.width || 0) / 2;
}

function centerY(element) {
  return (element.box?.y || 0) + (element.box?.height || 0) / 2;
}

function overlapsOnY(a, b) {
  const ay1 = a.box?.y || 0;
  const ay2 = ay1 + (a.box?.height || 0);
  const by1 = b.box?.y || 0;
  const by2 = by1 + (b.box?.height || 0);
  return Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
}

function overlapsOnX(a, b) {
  const ax1 = a.box?.x || 0;
  const ax2 = ax1 + (a.box?.width || 0);
  const bx1 = b.box?.x || 0;
  const bx2 = bx1 + (b.box?.width || 0);
  return Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
}

function elementRef(element) {
  return {
    selector: element.selector,
    auditType: element.auditType,
    auditRegion: element.auditRegion,
    text: element.text,
    box: element.box
  };
}

function buildHorizontalRelations(elements) {
  const relations = [];
  const sorted = [...elements].sort((a, b) => (a.box?.y || 0) - (b.box?.y || 0) || (a.box?.x || 0) - (b.box?.x || 0));
  for (let i = 0; i < sorted.length; i += 1) {
    const from = sorted[i];
    const candidates = sorted
      .filter((to) => {
        if (to === from) return false;
        if (to.auditRegion !== from.auditRegion) return false;
        const gap = (to.box?.x || 0) - ((from.box?.x || 0) + (from.box?.width || 0));
        if (gap < 0 || gap > 80) return false;
        const overlap = overlapsOnY(from, to);
        return overlap >= Math.min(from.box?.height || 0, to.box?.height || 0) * 0.45;
      })
      .sort((a, b) => (a.box?.x || 0) - (b.box?.x || 0));
    const to = candidates[0];
    if (!to) continue;
    relations.push({
      type: 'horizontal-gap',
      region: from.auditRegion,
      from: elementRef(from),
      to: elementRef(to),
      gap: Math.round((to.box?.x || 0) - ((from.box?.x || 0) + (from.box?.width || 0))),
      centerDeltaY: Math.round(centerY(to) - centerY(from)),
      verticalOverlap: Math.round(overlapsOnY(from, to))
    });
  }
  return relations;
}

function buildVerticalRelations(elements) {
  const relations = [];
  const sorted = [...elements].sort((a, b) => (a.box?.x || 0) - (b.box?.x || 0) || (a.box?.y || 0) - (b.box?.y || 0));
  for (let i = 0; i < sorted.length; i += 1) {
    const from = sorted[i];
    const candidates = sorted
      .filter((to) => {
        if (to === from) return false;
        if (to.auditRegion !== from.auditRegion) return false;
        const gap = (to.box?.y || 0) - ((from.box?.y || 0) + (from.box?.height || 0));
        if (gap < 0 || gap > 96) return false;
        const overlap = overlapsOnX(from, to);
        return overlap >= Math.min(from.box?.width || 0, to.box?.width || 0) * 0.35;
      })
      .sort((a, b) => (a.box?.y || 0) - (b.box?.y || 0));
    const to = candidates[0];
    if (!to) continue;
    relations.push({
      type: 'vertical-gap',
      region: from.auditRegion,
      from: elementRef(from),
      to: elementRef(to),
      gap: Math.round((to.box?.y || 0) - ((from.box?.y || 0) + (from.box?.height || 0))),
      centerDeltaX: Math.round(centerX(to) - centerX(from)),
      horizontalOverlap: Math.round(overlapsOnX(from, to))
    });
  }
  return relations;
}

function isTableLikeForRelations(element) {
  const signature = elementSignature(element);
  if (/px-ui-datatable-refresh/i.test(signature)) return false;
  return element.auditType === 'table'
    || /(^|[^a-z])(table|thead|tbody|tr|td|th)([^a-z]|$)|datatable|px-ui-column|header-content|px-table-name-title|px-ui-cell|sucstatus/i.test(signature);
}

function isLayoutActionControl(element) {
  const signature = elementSignature(element);
  const ownSignature = [element.tagName || '', element.auditType || '', element.className || ''].join(' ');
  if (['topbar', 'sidebar', 'framework'].includes(element.auditRegion)) return false;
  if (/px-radio|radiobutton|ui-radiobutton|px-checkbox|checkbox|switch/i.test(signature)) return false;
  if (/px-ui-form-buttons|px-form-btns/i.test(ownSignature)) return false;
  if (/px-ttoolbar-refresh/i.test(element.tagName || '')) return false;
  if (/px-ui-datatable-refresh|px-select-container|px-select-wrap|px-keywords-filter|px-ui-paginator-page|px-ui-paginator-next|px-ui-paginator-prev|px-ui-paginator-first|px-ui-paginator-last|px-select-for-table-paginator/i.test(signature)) return true;
  if (/ui-button/i.test(signature) && !/ui-button-text/i.test(signature)) return true;
  if ((element.semanticHints || []).includes('button') && !/ui-button-text/i.test(signature)) return true;
  if (element.auditType === 'button' && !/ui-button-text/i.test(signature)) return true;
  if (element.tagName === 'button') return true;
  if (isTableLikeForRelations(element)) return false;
  return false;
}

function layoutActionControls(elements) {
  const controls = elements
    .filter(isLayoutActionControl)
    .filter((element) => (element.box?.width || 0) >= 12 && (element.box?.height || 0) >= 12)
    .sort((a, b) => area(b.box) - area(a.box));

  return controls
    .filter((element, index) => {
      return !controls.slice(0, index).some((parent) => {
        if (Math.abs(centerY(parent) - centerY(element)) > 8) return false;
        return containsBox(parent.box || {}, element.box || {});
      });
    })
    .sort((a, b) => (a.box?.y || 0) - (b.box?.y || 0) || (a.box?.x || 0) - (b.box?.x || 0));
}

function buildActionGroups(elements) {
  const buckets = new Map();
  for (const element of layoutActionControls(elements)) {
    const key = `${element.auditRegion}:${Math.round(centerY(element) / 6) * 6}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(element);
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
    .map((items) => ({
      type: 'action-row',
      region: items[0].auditRegion,
      y: Math.round(centerY(items[0])),
      count: items.length,
      items: items.map(elementRef),
      gaps: items.slice(0, -1).map((item, index) => ({
        fromIndex: index,
        toIndex: index + 1,
        gap: Math.round((items[index + 1].box?.x || 0) - ((item.box?.x || 0) + (item.box?.width || 0)))
      }))
    }));
}

function buildRelations(elements) {
  return {
    horizontalGaps: buildHorizontalRelations(elements).slice(0, 500),
    verticalGaps: buildVerticalRelations(elements).slice(0, 500),
    actionGroups: buildActionGroups(elements).slice(0, 120)
  };
}

export function normalizeRuntimeEvidence(runtime) {
  const rawElements = runtime.elements || [];
  const viewport = runtime.viewport || {};
  const seen = new Set();
  const firstPass = [];
  const dropped = [];

  for (const element of rawElements) {
    const compact = compactElement(element, viewport);
    if (!isUsefulElement(compact, viewport)) {
      dropped.push({
        selector: compact.selector,
        auditType: compact.auditType,
        text: compact.text,
        box: compact.box,
        reason: isLargeContainer(compact, viewport) ? 'large-container-or-long-text' : 'low-signal'
      });
      continue;
    }
    const key = dedupeKey(compact);
    if (seen.has(key)) {
      dropped.push({
        selector: compact.selector,
        auditType: compact.auditType,
        text: compact.text,
        box: compact.box,
        reason: 'duplicate-geometry-text'
      });
      continue;
    }
    seen.add(key);
    firstPass.push(compact);
  }

  const normalizedElements = [];
  for (const element of firstPass) {
    if (shouldDropAsParentContainer(element, firstPass)) {
      dropped.push({
        selector: element.selector,
        auditType: element.auditType,
        text: element.text,
        box: element.box,
        reason: 'parent-wrapper-with-specific-children'
      });
      continue;
    }
    normalizedElements.push(element);
  }

  return {
    rawElementCount: rawElements.length,
    effectiveElementCount: normalizedElements.length,
    droppedElementCount: dropped.length,
    elements: normalizedElements,
    droppedElements: dropped.slice(0, 200),
    typeCounts: countBy(normalizedElements, 'auditType'),
    regionCounts: countBy(normalizedElements, 'auditRegion'),
    regions: buildRegionSummary(normalizedElements),
    relations: buildRelations(normalizedElements)
  };
}
