import fs from 'node:fs/promises';
import path from 'node:path';

function domSnapshotPaths(outPath) {
  const dir = path.dirname(outPath);
  return {
    raw: path.join(dir, 'dom-snapshot.raw.html'),
    pruned: path.join(dir, 'dom-snapshot.pruned.html')
  };
}

const EVIDENCE_SCRIPT = `(() => {
  const candidateSelector = [
    'button',
    'a',
    'input',
    'textarea',
    'select',
    'table',
    'thead',
    'tbody',
    '[role]',
    '[tabindex]',
    '[onclick]',
    '[aria-disabled]',
    '[aria-selected]',
    '[aria-checked]',
    '[contenteditable="true"]',
    '[class*="btn" i]',
    '[class*="button" i]',
    '[class*="input" i]',
    '[class*="select" i]',
    '[class*="table" i]',
    '[class*="datatable" i]',
    '[class*="px-ui" i]',
    '[class*="plx-" i]',
    '[class*="ui-" i]',
    '[class*="menu" i]',
    '[class*="nav" i]',
    '[class*="tab" i]',
    '[class*="pagination" i]',
    '[class*="badge" i]',
    '[class*="status" i]',
    '[class*="tag" i]',
    '[class*="grid" i]',
    '[class*="row" i]',
    '[class*="cell" i]',
    '[class*="column" i]',
    '[class*="header" i]',
    '[class*="toolbar" i]',
    '[class*="search" i]',
    '[class*="form" i]',
    '[class*="checkbox" i]',
    '[class*="radio" i]',
    '[class*="pager" i]',
    '[class*="page" i]',
    'px-lazydatatable',
    'px-editdatatable',
    'px-ttoolbar',
    'px-ttoolbar-keywordfilter',
    'px-ttoolbar-columntoggler',
    'px-ttoolbar-refresh',
    'plx-tabset',
    'plx-select',
    'plx-search'
  ].join(',');

  function visibleText(el) {
    return (el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('title') || '')
      .replace(/\\s+/g, ' ')
      .trim();
  }

  function ancestryFor(el) {
    const chain = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && chain.length < 10) {
      chain.push({
        tag: node.tagName.toLowerCase(),
        id: node.id || '',
        className: String(node.className || '').slice(0, 180)
      });
      node = node.parentElement;
    }
    return chain;
  }

  function selectorFor(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      const classNames = Array.from(node.classList || [])
        .filter((name) => !/^css-|^ng-|^_/.test(name))
        .slice(0, 2);
      if (classNames.length) part += classNames.map((name) => '.' + CSS.escape(name)).join('');
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  function styleOf(el) {
    const s = window.getComputedStyle(el);
    return {
      display: s.display,
      position: s.position,
      color: s.color,
      backgroundColor: s.backgroundColor,
      borderTopColor: s.borderTopColor,
      borderRightColor: s.borderRightColor,
      borderBottomColor: s.borderBottomColor,
      borderLeftColor: s.borderLeftColor,
      borderStyle: s.borderStyle,
      borderWidth: s.borderWidth,
      borderRadius: s.borderRadius,
      boxShadow: s.boxShadow,
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      lineHeight: s.lineHeight,
      padding: s.padding,
      margin: s.margin,
      cursor: s.cursor,
      opacity: s.opacity,
      pointerEvents: s.pointerEvents,
      textAlign: s.textAlign,
      verticalAlign: s.verticalAlign,
      zIndex: s.zIndex
    };
  }

  function isVisible(el, rect, style) {
    if (!rect || rect.width < 2 || rect.height < 2) return false;
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (Number(style.opacity) === 0) return false;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= viewportWidth || rect.top >= viewportHeight) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    return true;
  }

  function isPainted(el, rect) {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const points = [
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.left + Math.min(rect.width - 1, 4), rect.top + Math.min(rect.height - 1, 4)],
      [rect.right - Math.min(rect.width - 1, 4), rect.bottom - Math.min(rect.height - 1, 4)]
    ];
    return points.some(([x, y]) => {
      if (x < 0 || y < 0 || x >= viewportWidth || y >= viewportHeight) return false;
      const stack = document.elementsFromPoint(x, y);
      return stack.some((node) => node === el || el.contains(node) || node.contains(el));
    });
  }

  function isClickable(el, style) {
    const tag = el.tagName.toLowerCase();
    if (['button', 'a', 'select', 'summary'].includes(tag)) return true;
    if (['input', 'textarea'].includes(tag)) return true;
    if (['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch'].includes(el.getAttribute('role'))) return true;
    if (el.onclick || el.getAttribute('onclick')) return true;
    if (style.cursor === 'pointer') return true;
    if (el.tabIndex >= 0 && !['body', 'html'].includes(tag)) return true;
    return false;
  }

  function semanticHints(el, style) {
    const text = visibleText(el).slice(0, 120);
    const cls = String(el.className || '');
    const role = el.getAttribute('role') || '';
    const tag = el.tagName.toLowerCase();
    const label = tag + ' ' + role + ' ' + cls + ' ' + text;
    const hints = [];
    if (/button|btn/i.test(label) || /^(确定|取消|保存|提交|删除|新增|新建|查询|搜索|导出|导入|修改|编辑|重置|登录|开始检测|查看报告)$/.test(text)) hints.push('button');
    if (/input|textbox|searchbox/i.test(label) || tag === 'input' || tag === 'textarea') hints.push('input');
    if (/select|combobox|listbox/i.test(label) || tag === 'select') hints.push('select');
    if (/table|grid|treegrid|tbody|thead|row|cell|column/i.test(label) || tag === 'table' || ['tr', 'td', 'th'].includes(tag)) hints.push('table');
    if (/menu|nav|sidebar/i.test(label)) hints.push('menu');
    if (/tab/i.test(label)) hints.push('tab');
    if (/pagination|pager|上一页|下一页/.test(label)) hints.push('pagination');
    if (/badge|status|tag/i.test(label) || /(成功|失败|异常|警告|运行中|启用|停用|正常|可用|不可用)/.test(text)) hints.push('status');
    if (style.cursor === 'pointer' && !hints.length) hints.push('clickable');
    return hints;
  }

  function isTextLeaf(el) {
    const text = visibleText(el);
    if (!text || text.length > 160) return false;
    const children = Array.from(el.children || []).filter((child) => {
      const rect = child.getBoundingClientRect();
      const style = window.getComputedStyle(child);
      return isVisible(child, rect, style) && visibleText(child);
    });
    return children.length === 0;
  }

  function isVisualStructure(el, style) {
    const tag = el.tagName.toLowerCase();
    const cls = String(el.className || '');
    const role = el.getAttribute('role') || '';
    const label = tag + ' ' + role + ' ' + cls;
    if (/table|datatable|grid|treegrid|row|cell|column|toolbar|ttoolbar|form|search|pagination|pager|checkbox|radio|switch|input|select|btn|button|px-ui|plx-/i.test(label)) return true;
    if (['tr', 'td', 'th', 'label'].includes(tag)) return true;
    if (style.borderWidth !== '0px' && style.borderStyle !== 'none') return true;
    return false;
  }

  function buildDomSnapshot() {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('script,noscript').forEach((node) => node.remove());
    clone.querySelectorAll('*').forEach((node) => {
      for (const attr of Array.from(node.attributes || [])) {
        const name = String(attr.name || '').toLowerCase();
        if (name.startsWith('on')) {
          node.removeAttribute(attr.name);
          continue;
        }
        if (name === 'style' && String(attr.value || '').length > 800) {
          node.setAttribute('style', String(attr.value).slice(0, 800));
        }
      }
    });
    return '<!doctype html>\\n' + clone.outerHTML;
  }

  const seen = new Set();
  const direct = Array.from(document.querySelectorAll(candidateSelector));
  const pointer = Array.from(document.querySelectorAll('body *')).filter((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return false;
    return window.getComputedStyle(el).cursor === 'pointer';
  });
  const textLeaves = Array.from(document.querySelectorAll('body *')).filter((el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    if (!isVisible(el, rect, style)) return false;
    if (rect.width < 6 || rect.height < 6) return false;
    return isTextLeaf(el) || isVisualStructure(el, style);
  });

  const candidates = [...direct, ...pointer, ...textLeaves].filter((el) => {
    if (seen.has(el)) return false;
    seen.add(el);
    return true;
  });

  const elements = candidates
    .map((el, index) => {
      const rect = el.getBoundingClientRect();
      const style = styleOf(el);
      if (!isVisible(el, rect, style)) return null;
      if (!isPainted(el, rect)) return null;
      return {
        index,
        selector: selectorFor(el),
        tagName: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || null,
        text: visibleText(el).slice(0, 200),
        className: String(el.className || '').slice(0, 260),
        id: el.id || null,
        name: el.getAttribute('name') || null,
        src: el.currentSrc || el.src || el.getAttribute('src') || null,
        ancestry: ancestryFor(el),
        box: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        clickable: isClickable(el, style),
        focusable: el.tabIndex >= 0 || ['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName),
        disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true' || style.pointerEvents === 'none',
        checked: el.checked ?? null,
        selected: el.getAttribute('aria-selected') === 'true' || el.selected === true,
        aria: {
          label: el.getAttribute('aria-label'),
          disabled: el.getAttribute('aria-disabled'),
          selected: el.getAttribute('aria-selected'),
          checked: el.getAttribute('aria-checked'),
          expanded: el.getAttribute('aria-expanded')
        },
        style,
        semanticHints: semanticHints(el, style)
      };
    })
    .filter(Boolean)
    .slice(0, 3000);

  const bodyStyle = styleOf(document.body);
  const htmlStyle = styleOf(document.documentElement);

  return {
    title: document.title,
    url: location.href,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      scrollX: window.scrollX,
      scrollY: window.scrollY
    },
    pageStyle: {
      body: bodyStyle,
      html: htmlStyle
    },
    elements,
    domSnapshotPruned: buildDomSnapshot()
  };
})()`;

function offsetFrameElements(data, frameInfo = {}) {
  const offset = frameInfo.offset || { x: 0, y: 0 };
  return (data.elements || []).map((element) => ({
    ...element,
    frame: {
      url: data.url,
      name: frameInfo.name || '',
      path: frameInfo.path || []
    },
    selector: frameInfo.selector ? `${frameInfo.selector} :: ${element.selector}` : element.selector,
    ancestry: [
      {
        tag: 'iframe-document',
        id: frameInfo.id || '',
        className: frameInfo.className || ''
      },
      ...(element.ancestry || [])
    ],
    box: {
      ...element.box,
      x: Math.round((element.box?.x || 0) + (offset.x || 0)),
      y: Math.round((element.box?.y || 0) + (offset.y || 0))
    }
  }));
}

function iframeInfoForFrame(parentData, childFrame, index) {
  const iframeElements = (parentData.elements || []).filter((element) => element.tagName === 'iframe');
  if (!iframeElements.length) return null;
  const childUrl = childFrame.url || '';
  const exact = iframeElements.find((element) => element.src && childUrl && element.src === childUrl);
  const byName = iframeElements.find((element) => element.name && childFrame.name && element.name === childFrame.name);
  const iframe = exact || byName || iframeElements[index] || iframeElements[0];
  return {
    id: iframe.id || '',
    name: iframe.name || childFrame.name || '',
    className: iframe.className || '',
    selector: iframe.selector,
    offset: {
      x: iframe.box?.x || 0,
      y: iframe.box?.y || 0
    }
  };
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function progress(options, phase, message, details = {}) {
  options.onProgress?.({ phase, message, ...details });
}

async function collectFrameTree(frame, frameInfo = {}, options = {}) {
  const frameLabel = frameInfo.path?.length
    ? `iframe ${frameInfo.path.join('.')}`
    : '主文档';
  progress(options, 'collector:frame:start', `开始扫描${frameLabel}`, {
    framePath: frameInfo.path || [],
    frameUrl: frame.url || ''
  });
  const diagnostic = await withTimeout(
    frame.executeJavaScript(`(() => ({
      title: document.title,
      url: location.href,
      domElementCount: document.getElementsByTagName('*').length,
      iframeCount: document.querySelectorAll('iframe').length,
      bodyChildCount: document.body?.children?.length || 0
    }))()`, true),
    10000,
    `${frameLabel}基础信息读取`
  );
  progress(
    options,
    'collector:frame:diagnostic',
    `${frameLabel}基础信息：DOM ${diagnostic.domElementCount} 个，iframe ${diagnostic.iframeCount} 个`,
    { framePath: frameInfo.path || [], ...diagnostic }
  );
  const frameStartedAt = Date.now();
  const data = await withTimeout(
    frame.executeJavaScript(EVIDENCE_SCRIPT, true),
    options.frameTimeoutMs || 60000,
    `${frameLabel}元素与样式扫描`
  );
  const frameElements = offsetFrameElements(data, frameInfo);
  const childFrames = frame.frames || [];
  const childResults = [];
  const frameErrors = [];
  progress(
    options,
    'collector:frame:done',
    `${frameLabel}扫描完成：${frameElements.length} 个候选元素，耗时 ${Date.now() - frameStartedAt}ms`,
    {
      framePath: frameInfo.path || [],
      elementCount: frameElements.length,
      childFrameCount: childFrames.length,
      durationMs: Date.now() - frameStartedAt
    }
  );

  for (let index = 0; index < childFrames.length; index += 1) {
    const child = childFrames[index];
    let childInfo = null;
    try {
      childInfo = iframeInfoForFrame(data, child, index) || {
        name: child.name || '',
        selector: '',
        offset: frameInfo.offset || { x: 0, y: 0 }
      };
      childInfo.path = [...(frameInfo.path || []), index];
      const childResult = await collectFrameTree(child, childInfo, options);
      childResults.push(childResult);
    } catch (error) {
      progress(options, 'collector:frame:failed', `iframe ${childInfo?.path?.join('.') || index} 扫描失败，已跳过：${error?.message || String(error)}`, {
        framePath: childInfo?.path || [...(frameInfo.path || []), index],
        frameUrl: child.url || '',
        error: error?.message || String(error)
      });
      frameErrors.push({
        url: child.url || '',
        name: child.name || '',
        message: error?.message || String(error)
      });
    }
  }

  return {
    data,
    elements: [
      ...frameElements,
      ...childResults.flatMap((result) => result.elements || [])
    ],
    frames: [
      {
        url: data.url,
        title: data.title,
        name: frameInfo.name || '',
        path: frameInfo.path || [],
        elementCount: frameElements.length
      },
      ...childResults.flatMap((result) => result.frames || [])
    ],
    frameErrors: [
      ...frameErrors,
      ...childResults.flatMap((result) => result.frameErrors || [])
    ]
  };
}

export async function collectWebContentsEvidence(webContents, options = {}) {
  const outPath = path.resolve(options.out || 'runs/runtime.json');
  const screenshotPath = path.resolve(options.screenshot || 'runs/screenshot.png');

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.mkdir(path.dirname(screenshotPath), { recursive: true });

  progress(options, 'collector:prepare', '采集目录已创建，准备截取当前可视区域', {
    outPath,
    screenshotPath,
    pageUrl: webContents.getURL()
  });
  const screenshotStartedAt = Date.now();
  const image = await withTimeout(webContents.capturePage(), 30000, '页面截图');
  progress(options, 'collector:screenshot:captured', `页面截图完成，耗时 ${Date.now() - screenshotStartedAt}ms`, {
    durationMs: Date.now() - screenshotStartedAt,
    width: image.getSize().width,
    height: image.getSize().height
  });
  await fs.writeFile(screenshotPath, image.toPNG());
  progress(options, 'collector:screenshot:written', '截图已写入磁盘', { screenshotPath });

  const frameTree = webContents.mainFrame
    ? await collectFrameTree(
      webContents.mainFrame,
      { name: 'main', path: [], offset: { x: 0, y: 0 } },
      options
    )
    : null;
  progress(options, 'collector:frames:done', `全部文档扫描结束：${frameTree?.frames?.length || 1} 个文档`, {
    frameCount: frameTree?.frames?.length || 1,
    frameErrorCount: frameTree?.frameErrors?.length || 0
  });
  const data = frameTree?.data || await webContents.executeJavaScript(EVIDENCE_SCRIPT, true);
  const result = {
    ok: true,
    collectedAt: new Date().toISOString(),
    requestedUrl: options.requestedUrl || webContents.getURL(),
    finalUrl: data.url,
    screenshot: screenshotPath,
    ...data,
    elements: frameTree?.elements || data.elements,
    frames: frameTree?.frames || [{ url: data.url, title: data.title, elementCount: data.elements?.length || 0 }],
    frameErrors: frameTree?.frameErrors || []
  };

  const snapshotPaths = domSnapshotPaths(outPath);
  const rawHtml = await withTimeout(
    webContents.executeJavaScript('document.documentElement ? "<!doctype html>\\n" + document.documentElement.outerHTML : ""', true),
    30000,
    'DOM 原始快照'
  );
  await fs.writeFile(snapshotPaths.raw, String(rawHtml || ''), 'utf8');
  await fs.writeFile(snapshotPaths.pruned, String(data.domSnapshotPruned || ''), 'utf8');
  result.domSnapshot = {
    rawPath: snapshotPaths.raw,
    prunedPath: snapshotPaths.pruned
  };
  delete result.domSnapshotPruned;

  progress(options, 'collector:runtime:writing', `正在写入 runtime.json，元素 ${result.elements.length} 个`, {
    outPath,
    elementCount: result.elements.length
  });
  await fs.writeFile(outPath, JSON.stringify(result, null, 2), 'utf8');
  const stat = await fs.stat(outPath);
  progress(options, 'collector:runtime:written', `runtime.json 写入完成，大小 ${Math.round(stat.size / 1024)}KB`, {
    outPath,
    bytes: stat.size,
    elementCount: result.elements.length
  });
  return result;
}
