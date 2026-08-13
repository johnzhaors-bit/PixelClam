import fs from 'node:fs/promises';
import path from 'node:path';

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function readJson(filePath, fallback = null) {
  try {
    return safeJsonParse(await fs.readFile(filePath, 'utf8'), fallback);
  } catch {
    return fallback;
  }
}

function fileExists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

function elementSignature(element = {}) {
  const ancestry = Array.isArray(element.ancestry)
    ? element.ancestry.map((item) => `${item.tag || ''} ${item.id || ''} ${item.className || ''}`).join(' ')
    : '';
  return [
    element.tagName || '',
    element.id || '',
    element.className || '',
    element.selector || '',
    element.text || '',
    ancestry,
    ...(element.semanticHints || [])
  ].join(' ').toLowerCase();
}

function compactText(value, limit = 48) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function detectSkinId(runtime = {}) {
  const pageText = JSON.stringify({
    pageStyle: runtime.pageStyle || {},
    bodyClass: runtime.bodyClassName || '',
    htmlClass: runtime.htmlClassName || '',
    title: runtime.title || ''
  }).toLowerCase();
  const known = [
    'default',
    'niv',
    'night-sky',
    'nostalgia',
    'space-gray',
    'vmax',
    'ai-light',
    'fantasy-blue',
    'indigo',
    'ai-dark'
  ];
  return known.find((item) => pageText.includes(item)) || 'unknown';
}

function getByPath(target, dottedPath) {
  if (!target || !dottedPath) return undefined;
  return dottedPath.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), target);
}

function normalizeRequiredField(field = '') {
  return String(field || '').trim();
}

function defaultStateSamples(matchCount, requiredStates = []) {
  const fallbackState = requiredStates[0] || 'default';
  return Array.from({ length: matchCount }, (_, index) => ({
    state: fallbackState,
    sampleIndex: index + 1
  }));
}

function componentMatcher(item) {
  switch (item.id) {
    case 'sendbox-tool-icon-runtime-color':
    case 'sendbox-send-glyph-runtime-color':
    case 'sendbox-clear-border-runtime-color':
      return /(sendbox|message-send|chat-input|copilot|clear-icon|send-btn|input-tips|prompt-input|answer-input)/i;
    case 'event-preview-geometry':
      return /(event-preview|timeline|event-item|preview-time|preview-title|preview-brief)/i;
    default:
      return new RegExp(item.component || item.id, 'i');
  }
}

function findMatches(elements = [], item) {
  const matcher = componentMatcher(item);
  return elements.filter((element) => matcher.test(elementSignature(element)));
}

function buildFieldValueMap(match, runtime, itemId) {
  const viewport = runtime.viewport || {};
  const style = match?.style || {};
  const bbox = match?.box || {};
  const eventPreview = match?.__eventPreviewStructure || null;
  const common = {
    bbox,
    viewport,
    runtime: {
      dpr: viewport.devicePixelRatio ?? viewport.dpr ?? null
    },
    computedStyle: {
      ...style,
      width: bbox.width != null ? `${bbox.width}px` : null,
      height: bbox.height != null ? `${bbox.height}px` : null
    },
    button: {
      bbox,
      computedStyle: {
        ...style,
        width: bbox.width != null ? `${bbox.width}px` : null,
        height: bbox.height != null ? `${bbox.height}px` : null
      }
    },
    glyph: {
      computedStyle: {
        color: style.color ?? null,
        fill: style.color ?? null,
        stroke: style.color ?? null
      }
    },
    'event-preview-container': {
      bbox: eventPreview?.container?.bbox || bbox,
      computedStyle: {
        padding: eventPreview?.container?.computedStyle?.padding ?? style.padding ?? null,
        margin: eventPreview?.container?.computedStyle?.margin ?? style.margin ?? null,
        borderRadius: eventPreview?.container?.computedStyle?.borderRadius ?? style.borderRadius ?? null,
        backgroundColor: eventPreview?.container?.computedStyle?.backgroundColor ?? style.backgroundColor ?? null
      }
    },
    'event-preview-title': {
      bbox: eventPreview?.title?.bbox || (/title|标题/i.test(elementSignature(match)) ? bbox : null)
    },
    'event-preview-brief': {
      bbox: eventPreview?.brief?.bbox || (/brief|描述|正文/i.test(elementSignature(match)) ? bbox : null)
    },
    'event-preview-time': {
      bbox: eventPreview?.time?.bbox || (/time|时间/i.test(elementSignature(match)) ? bbox : null)
    },
    'event-item-parent': {
      bbox: eventPreview?.parent?.bbox || bbox
    },
    closestSendboxShell: {
      selector: /sendbox|message-send|copilot|chat-input/i.test(elementSignature(match)) ? String(match.selector || '') : null
    }
  };

  if (itemId.startsWith('sendbox-') && !common.closestSendboxShell.selector) {
    common.closestSendboxShell.selector = String(match.selector || '');
  }

  return common;
}

function sortByGeometry(elements = []) {
  return [...elements].sort((a, b) => {
    const ay = Number(a?.box?.y || 0);
    const by = Number(b?.box?.y || 0);
    if (ay !== by) return ay - by;
    return Number(a?.box?.x || 0) - Number(b?.box?.x || 0);
  });
}

function deriveEventPreviewStructure(matches = []) {
  if (!Array.isArray(matches) || !matches.length) return null;
  const items = sortByGeometry(matches);
  const bySignature = (pattern) => items.find((item) => pattern.test(elementSignature(item)));
  const title = bySignature(/event-preview-title|preview-title|title|标题/i) || items[0] || null;
  const brief = bySignature(/event-preview-brief|preview-brief|brief|摘要|描述|正文/i)
    || items.find((item) => item !== title)
    || null;
  const time = bySignature(/event-preview-time|preview-time|time|时间/i)
    || items.find((item) => item !== title && item !== brief)
    || null;

  const boxes = items.map((item) => item.box).filter(Boolean);
  if (!boxes.length) return null;
  const left = Math.min(...boxes.map((box) => Number(box.x || 0)));
  const top = Math.min(...boxes.map((box) => Number(box.y || 0)));
  const right = Math.max(...boxes.map((box) => Number(box.x || 0) + Number(box.width || 0)));
  const bottom = Math.max(...boxes.map((box) => Number(box.y || 0) + Number(box.height || 0)));
  const containerBox = { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };

  return {
    container: {
      bbox: containerBox,
      computedStyle: title?.style || brief?.style || time?.style || items[0]?.style || {}
    },
    title: title ? { bbox: title.box || null } : null,
    brief: brief ? { bbox: brief.box || null } : null,
    time: time ? { bbox: time.box || null } : null,
    parent: {
      bbox: containerBox
    }
  };
}

function mergeComputedStateIntoFieldMap(fieldMap, sample) {
  if (!sample) return fieldMap;
  const box = sample.box || {};
  const style = sample.computedStyle || {};
  return {
    ...fieldMap,
    bbox: box.width != null ? box : fieldMap.bbox,
    computedStyle: {
      ...(fieldMap.computedStyle || {}),
      ...style,
      width: box.width != null ? `${box.width}px` : fieldMap.computedStyle?.width ?? null,
      height: box.height != null ? `${box.height}px` : fieldMap.computedStyle?.height ?? null
    },
    button: {
      ...(fieldMap.button || {}),
      bbox: box.width != null ? box : fieldMap.button?.bbox,
      computedStyle: {
        ...(fieldMap.button?.computedStyle || {}),
        ...style,
        width: box.width != null ? `${box.width}px` : fieldMap.button?.computedStyle?.width ?? null,
        height: box.height != null ? `${box.height}px` : fieldMap.button?.computedStyle?.height ?? null
      }
    },
    glyph: {
      computedStyle: {
        ...(fieldMap.glyph?.computedStyle || {}),
        color: style.color ?? fieldMap.glyph?.computedStyle?.color ?? null,
        fill: style.fill ?? fieldMap.glyph?.computedStyle?.fill ?? null,
        stroke: style.stroke ?? fieldMap.glyph?.computedStyle?.stroke ?? null
      }
    },
    'event-preview-container': {
      bbox: box.width != null ? box : fieldMap['event-preview-container']?.bbox,
      computedStyle: {
        ...(fieldMap['event-preview-container']?.computedStyle || {}),
        padding: style.padding ?? fieldMap['event-preview-container']?.computedStyle?.padding ?? null,
        margin: style.margin ?? fieldMap['event-preview-container']?.computedStyle?.margin ?? null,
        borderRadius: style.borderRadius ?? fieldMap['event-preview-container']?.computedStyle?.borderRadius ?? null,
        backgroundColor: style.backgroundColor ?? fieldMap['event-preview-container']?.computedStyle?.backgroundColor ?? null
      }
    },
    'event-item-parent': {
      bbox: box.width != null ? box : fieldMap['event-item-parent']?.bbox
    }
  };
}

function resolveRequiredFields(match, runtime, item, stateSamples = []) {
  let fieldMap = buildFieldValueMap(match, runtime, item.id);
  for (const sample of stateSamples) {
    fieldMap = mergeComputedStateIntoFieldMap(fieldMap, sample);
  }
  const requiredFields = item.requiredFields || [];
  const missingFields = [];
  const satisfiedFields = [];
  for (const field of requiredFields) {
    const key = normalizeRequiredField(field);
    const value = getByPath(fieldMap, key);
    const present = value !== undefined && value !== null && value !== '';
    if (present) {
      satisfiedFields.push(key);
    } else {
      missingFields.push(key);
    }
  }
  return { satisfiedFields, missingFields };
}

function sampleCountForItem(matches = [], item = {}) {
  const min = Number(item.sampleRequirements?.minimumSampleCount || 2);
  return Math.min(matches.length, Math.max(1, min));
}

function buildReason(item, discovered, missingFields, sampleCount, requiredSampleCount) {
  if (!discovered) return '当前页面未命中该 runtime-verify 对象';
  if (missingFields.length) return `missing requiredFields: ${missingFields.join(', ')}`;
  if (sampleCount < requiredSampleCount) return `sample count ${sampleCount} < minimum ${requiredSampleCount}`;
  return 'requiredFields satisfied';
}

function buildLogMarkdown(summary, pendingItems, resolvedItems, undiscoveredItems) {
  const lines = [
    '# Runtime Resolution Log',
    '',
    `- runId: ${summary.runId}`,
    `- skillId: ${summary.skillId}`,
    `- pending: ${pendingItems.length}`,
    `- resolved: ${resolvedItems.length}`,
    `- undiscovered: ${undiscoveredItems.length}`,
    ''
  ];
  if (resolvedItems.length) {
    lines.push('## Resolved', '');
    for (const item of resolvedItems) {
      lines.push(`- ${item.id}: ${item.reason}`);
    }
    lines.push('');
  }
  if (pendingItems.length) {
    lines.push('## Pending', '');
    for (const item of pendingItems) {
      lines.push(`- ${item.id}: ${item.reason}`);
    }
    lines.push('');
  }
  if (undiscoveredItems.length) {
    lines.push('## Not Detected', '');
    for (const item of undiscoveredItems) {
      lines.push(`- ${item.id}: ${item.reason}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function captureSnapshotForSelector(page, selector) {
  if (!page || !selector) return null;
  try {
    const locator = page.locator(selector).first();
    const count = await locator.count();
    if (!count) return null;
    const box = await locator.boundingBox();
    if (!box) return null;
    return await locator.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return {
        box: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
        computedStyle: {
          color: style.color,
          fill: style.fill || null,
          stroke: style.stroke || null,
          opacity: style.opacity,
          cursor: style.cursor,
          fontSize: style.fontSize,
          backgroundColor: style.backgroundColor,
          borderColor: style.borderColor,
          borderTopColor: style.borderTopColor,
          borderRightColor: style.borderRightColor,
          borderBottomColor: style.borderBottomColor,
          borderLeftColor: style.borderLeftColor,
          borderTopWidth: style.borderTopWidth,
          borderRightWidth: style.borderRightWidth,
          borderBottomWidth: style.borderBottomWidth,
          borderLeftWidth: style.borderLeftWidth,
          borderRadius: style.borderRadius,
          boxShadow: style.boxShadow,
          padding: style.padding,
          margin: style.margin,
          transform: style.transform
        }
      };
    });
  } catch {
    return null;
  }
}

async function captureRuntimeStateSamples(page, match, item) {
  const selector = String(match?.selector || '').trim();
  if (!page || !selector) return { samples: [], coveredStates: [] };
  const requiredStates = Array.isArray(item.requiredStates) && item.requiredStates.length
    ? item.requiredStates
    : ['default'];
  const samples = [];
  for (const state of requiredStates) {
    try {
      const locator = page.locator(selector).first();
      const count = await locator.count();
      if (!count) continue;
      await locator.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(40);
      const isDisabledRequest = state === 'disabled';
      const initialSnapshot = isDisabledRequest ? await captureSnapshotForSelector(page, selector) : null;
      const initialDisabledLike = Boolean(initialSnapshot?.disabled)
        || String(initialSnapshot?.computedStyle?.cursor || '').includes('not-allowed')
        || Number(initialSnapshot?.computedStyle?.opacity || 1) < 1;
      if (state === 'hover') {
        await locator.hover({ force: true }).catch(() => {});
        await page.waitForTimeout(80);
      } else if (state === 'active') {
        const box = await locator.boundingBox();
        if (box) {
          await page.mouse.move(box.x + Math.max(2, box.width / 2), box.y + Math.max(2, box.height / 2));
          await page.mouse.down();
          await page.waitForTimeout(60);
        }
      }
      const snapshot = isDisabledRequest && initialSnapshot ? initialSnapshot : await captureSnapshotForSelector(page, selector);
      if (snapshot) {
        const disabledLike = Boolean(snapshot.disabled)
          || String(snapshot.computedStyle?.cursor || '').includes('not-allowed')
          || Number(snapshot.computedStyle?.opacity || 1) < 1;
        if (state !== 'disabled' || disabledLike || initialDisabledLike) {
          samples.push({
            state,
            selector,
            ...snapshot
          });
        }
      }
      if (state === 'active') {
        await page.mouse.up().catch(() => {});
        await page.waitForTimeout(40);
      }
    } catch {
      // ignore per-state sampling failures
    }
  }
  return {
    samples,
    coveredStates: [...new Set(samples.map((sample) => sample.state))]
  };
}

export async function resolveRuntimeOpenItems({ runtime, normalizedEvidence, skill, runId, runDir }) {
  const methodologyDir = path.join(skill.path, 'framework', 'methodology');
  const extractionDir = path.join(skill.path, 'extraction');
  const queue = await readJson(path.join(methodologyDir, 'runtime-resolution-queue.json'), { items: [] });
  const capture = await readJson(path.join(methodologyDir, 'runtime-evidence-capture.json'), { captureProfiles: [] });
  const resolutionProfile = await readJson(path.join(methodologyDir, 'open-item-resolution-profile.json'), {});
  const openRegistry = await readJson(path.join(extractionDir, 'open-items-registry.json'), { items: [] });

  const queueItems = Array.isArray(queue?.items) ? queue.items : [];
  const captureProfiles = new Map((capture?.captureProfiles || []).map((item) => [item.id, item]));
  const registryItems = new Map((openRegistry?.items || []).map((item) => [item.id, item]));
  const elements = normalizedEvidence?.elements || runtime?.normalizedElements || runtime?.elements || [];
  const skinId = detectSkinId(runtime);
  const discoveredItems = [];
  const pendingItems = [];
  const resolvedItems = [];
  const undiscoveredItems = [];
  const evidenceItems = [];
  const page = runtime?.__session?.page || null;

  for (const item of queueItems) {
    const captureProfile = captureProfiles.get(item.captureProfileId) || null;
    const registry = registryItems.get(item.id) || null;
    const matches = findMatches(elements, item);
    const discovered = matches.length > 0;
    const sampleCount = sampleCountForItem(matches, item);
    const requiredSampleCount = Number(item.sampleRequirements?.minimumSampleCount || queue?.queuePolicy?.minimumConsistencySamples || 2);
    const primaryMatch = matches[0]
      ? {
        ...matches[0],
        __eventPreviewStructure: item.id === 'event-preview-geometry'
          ? deriveEventPreviewStructure(matches)
          : null
      }
      : null;
    const runtimeStateSamples = primaryMatch && page
      ? await captureRuntimeStateSamples(page, primaryMatch, item)
      : { samples: [], coveredStates: [] };
    const fieldResolution = primaryMatch
      ? resolveRequiredFields(
        primaryMatch,
        runtime,
        { ...item, requiredFields: captureProfile?.requiredFields || item.requiredFields || [] },
        runtimeStateSamples.samples
      )
      : { satisfiedFields: [], missingFields: [...(captureProfile?.requiredFields || item.requiredFields || [])] };

    const stateSamples = runtimeStateSamples.samples.length
      ? runtimeStateSamples.samples
      : defaultStateSamples(sampleCount, item.requiredStates || []);
    const coveredStates = runtimeStateSamples.coveredStates.length
      ? runtimeStateSamples.coveredStates
      : [...new Set(stateSamples.map((sample) => sample.state))];
    const requiredStates = item.requiredStates || [];
    const stateCoverageSatisfied = requiredStates.every((state) => coveredStates.includes(state));

    const itemEvidence = {
      id: item.id,
      component: item.component,
      captureProfileId: item.captureProfileId,
      ownerPass: item.ownerPass,
      skinId,
      discovered,
      matchCount: matches.length,
      sampleCount,
      sampleStates: stateSamples,
      requiredStates,
      coveredStates,
      stateCoverageSatisfied,
      requiredFields: captureProfile?.requiredFields || item.requiredFields || [],
      satisfiedFields: fieldResolution.satisfiedFields,
      missingFields: fieldResolution.missingFields,
      sampleElements: matches.slice(0, 3).map((element) => ({
        selector: String(element.selector || ''),
        text: compactText(element.text, 80),
        auditType: element.auditType,
        auditRegion: element.auditRegion,
        box: element.box || null
      })),
      reportHint: registry?.reportLanguage || '',
      statusPolicy: resolutionProfile?.openItemOwnership?.[item.id] || null
    };
    evidenceItems.push(itemEvidence);

    const requiredFieldsSatisfied = discovered && fieldResolution.missingFields.length === 0;
    const canUpgrade = requiredFieldsSatisfied && sampleCount >= requiredSampleCount && stateCoverageSatisfied;
    const policy = resolutionProfile?.statusPolicy?.['runtime-verify'] || {};
    const reason = !discovered
      ? '当前页面未命中该 runtime-verify 对象'
      : !stateCoverageSatisfied
        ? `required states not covered: expected ${requiredStates.join(', ')} got ${coveredStates.join(', ') || 'none'}`
        : buildReason(item, discovered, fieldResolution.missingFields, sampleCount, requiredSampleCount);

    const result = {
      id: item.id,
      component: item.component,
      ownerPass: item.ownerPass,
      statusBefore: item.statusBeforeUpgrade || 'runtime-verify',
      statusAfter: canUpgrade ? (item.statusAfterUpgrade || 'confirmed') : 'runtime-verify',
      discovered,
      sampleCount,
      requiredSampleCount,
      requiredFieldsSatisfied,
      stateCoverageSatisfied,
      requiredStates,
      coveredStates,
      deductionEnabled: canUpgrade && Boolean(policy.hardDeductionAllowedWithRuntimeEvidence ?? true),
      reportBucket: canUpgrade
        ? (policy.reportBucketWithRuntimeEvidence || 'confirmed-issues-or-passes')
        : (policy.reportBucketWithoutRuntimeEvidence || 'needs-runtime-verification'),
      reason,
      missingFields: fieldResolution.missingFields,
      satisfiedFields: fieldResolution.satisfiedFields,
      sampleElements: itemEvidence.sampleElements
    };

    if (!discovered) {
      undiscoveredItems.push(result);
      continue;
    }

    discoveredItems.push(result);
    if (canUpgrade) {
      resolvedItems.push(result);
    } else {
      pendingItems.push(result);
    }
  }

  const runtimeEvidence = {
    runId,
    pageUrl: runtime?.url || runtime?.finalUrl || runtime?.requestedUrl || '',
    pageTitle: runtime?.title || '',
    skinId,
    auditMode: runtime?.auditMode || runtime?.evidenceMode || runtime?.inputMode || 'dom',
    viewport: {
      width: runtime?.viewport?.width ?? null,
      height: runtime?.viewport?.height ?? null,
      dpr: runtime?.viewport?.devicePixelRatio ?? null
    },
    items: evidenceItems
  };

  const runtimeResolution = {
    runId,
    skillId: skill.id,
    resolvedItems,
    pendingItems,
    undiscoveredItems,
    summary: {
      totalQueueItems: queueItems.length,
      discoveredCount: discoveredItems.length,
      resolvedCount: resolvedItems.length,
      pendingCount: pendingItems.length,
      undiscoveredCount: undiscoveredItems.length
    }
  };

  const runtimeResolutionSummary = {
    runId,
    skillId: skill.id,
    skinId,
    queueItems: queueItems.length,
    discoveredCount: discoveredItems.length,
    resolvedCount: resolvedItems.length,
    pendingCount: pendingItems.length,
    undiscoveredCount: undiscoveredItems.length,
    hasRuntimeVerifyHits: discoveredItems.length > 0,
    message: discoveredItems.length
      ? `命中 ${discoveredItems.length} 个 runtime-verify 开放项；已升级 ${resolvedItems.length} 个，待补证 ${pendingItems.length} 个。`
      : '当前页面未命中 runtime-verify 开放项。'
  };

  const logContent = buildLogMarkdown({
    runId,
    skillId: skill.id
  }, pendingItems, resolvedItems, undiscoveredItems);

  const runtimeEvidencePath = path.join(runDir, 'runtime-evidence.json');
  const runtimeResolutionPath = path.join(runDir, 'runtime-resolution.json');
  const runtimeResolutionLogPath = path.join(runDir, 'runtime-resolution-log.md');

  await fs.writeFile(runtimeEvidencePath, JSON.stringify(runtimeEvidence, null, 2), 'utf8');
  await fs.writeFile(runtimeResolutionPath, JSON.stringify(runtimeResolution, null, 2), 'utf8');
  await fs.writeFile(runtimeResolutionLogPath, logContent, 'utf8');

  return {
    runtimeEvidence,
    runtimeResolution,
    runtimeResolutionSummary,
    runtimeEvidencePath,
    runtimeResolutionPath,
    runtimeResolutionLogPath,
    runtimeResolutionLogExists: await fileExists(runtimeResolutionLogPath)
  };
}
