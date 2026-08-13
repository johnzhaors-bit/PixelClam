#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

function getCliOption(name, fallback = null) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length).trim() || fallback : fallback;
}

function parseViewport(value) {
  const match = String(value || '').match(/^(\d+)x(\d+)$/);
  if (!match) return { width: 1440, height: 900 };
  return { width: Number(match[1]), height: Number(match[2]) };
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

export function normalizeUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^(https?|file):\/\//i.test(text)) return text;
  return `https://${text}`;
}

function emit(event) {
  console.log(JSON.stringify(event));
}

function domSnapshotPaths(outPath) {
  const dir = path.dirname(outPath);
  return {
    raw: path.join(dir, 'dom-snapshot.raw.html'),
    pruned: path.join(dir, 'dom-snapshot.pruned.html')
  };
}

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (error) {
    throw new Error(`Playwright 未安装。请先执行 npm install && npx playwright install chromium。${error?.message || ''}`);
  }
}

export async function collectPageEvidence(page, options = {}) {
  const outPath = path.resolve(options.out || 'runs/runtime.json');
  const screenshotPath = path.resolve(options.screenshot || 'runs/screenshot.png');
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.mkdir(path.dirname(screenshotPath), { recursive: true });

  emit({ phase: 'page:screenshot', message: '保存当前页面截图' });
  await page.screenshot({ path: screenshotPath, fullPage: true });

  emit({ phase: 'page:evaluate', message: '采集当前页 DOM、样式和元素位置' });
  const data = await page.evaluate(() => {
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
        .replace(/\s+/g, ' ')
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
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts = [];
      let node = el;
      while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
        let part = node.tagName.toLowerCase();
        const classNames = Array.from(node.classList || [])
          .filter((name) => !/^css-|^ng-|^_/.test(name))
          .slice(0, 2);
        if (classNames.length) part += classNames.map((name) => `.${CSS.escape(name)}`).join('');
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
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
      const label = `${tag} ${role} ${cls} ${text}`;
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
      const label = `${tag} ${role} ${cls}`;
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
      return '<!doctype html>\n' + clone.outerHTML;
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
      return '<!doctype html>\n' + clone.outerHTML;
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
      .slice(0, 2000);

    const bodyStyle = styleOf(document.body);
    const htmlStyle = styleOf(document.documentElement);

    return {
      title: document.title,
      url: location.href,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio
      },
      pageStyle: {
        body: bodyStyle,
        html: htmlStyle
      },
      elements,
      domSnapshotPruned: buildDomSnapshot()
    };
  });

  const result = {
    ok: true,
    collectedAt: new Date().toISOString(),
    requestedUrl: options.requestedUrl || page.url(),
    finalUrl: data.url,
    manualLogin: Boolean(options.manualLogin),
    screenshot: screenshotPath,
    ...data
  };

  const snapshotPaths = domSnapshotPaths(outPath);
  await fs.writeFile(snapshotPaths.raw, '<!doctype html>\n' + (await page.content()), 'utf8');
  await fs.writeFile(snapshotPaths.pruned, String(data.domSnapshotPruned || ''), 'utf8');
  result.domSnapshot = {
    rawPath: snapshotPaths.raw,
    prunedPath: snapshotPaths.pruned
  };
  delete result.domSnapshotPruned;

  await fs.writeFile(outPath, JSON.stringify(result, null, 2), 'utf8');
  emit({ phase: 'collector:done', message: '当前页采集完成', out: outPath, screenshot: screenshotPath, elements: result.elements.length });
  return result;
}

export async function collectRuntimeUi(options) {
  const url = normalizeUrl(options.url);
  if (!url) throw new Error('缺少 URL');

  const outPath = path.resolve(options.out || 'runs/runtime.json');
  const screenshotPath = path.resolve(options.screenshot || 'runs/screenshot.png');
  const viewport = parseViewport(options.viewport || '1440x900');
  const waitUntil = options.waitUntil || 'domcontentloaded';
  const ignoreHTTPSErrors = options.ignoreHTTPSErrors !== false;
  const manualLogin = Boolean(options.manualLogin);
  const manualWaitMs = Number(options.manualWaitMs || 90000);
  const userDataDir = path.resolve(options.userDataDir || path.join(path.dirname(outPath), '..', '.browser-profile'));

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.mkdir(path.dirname(screenshotPath), { recursive: true });

  emit({ phase: 'collector:init', message: '加载 Playwright' });
  const { chromium } = await loadPlaywright();

  emit({ phase: 'browser:launch', message: manualLogin ? '启动可登录 Chromium' : '启动 Chromium' });
  let browser = null;
  let context = null;
  let page = null;

  if (manualLogin) {
    await fs.mkdir(userDataDir, { recursive: true });
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      viewport,
      ignoreHTTPSErrors
    });
    page = context.pages()[0] || await context.newPage();
  } else {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport, ignoreHTTPSErrors });
    page = await context.newPage();
  }

  page.setDefaultTimeout(20000);

  emit({ phase: 'page:goto', message: `打开页面：${url}` });
  await page.goto(url, { waitUntil });
  if (manualLogin) {
    emit({
      phase: 'login:manual',
      message: `登录模式：请在弹出的 Chromium 中完成登录并进入要检测的业务页面，${Math.round(manualWaitMs / 1000)} 秒后自动采集`
    });
    await page.waitForTimeout(manualWaitMs);
    const pages = context.pages();
    page = pages[pages.length - 1] || page;
  } else {
    await page.waitForTimeout(1200);
  }

  emit({ phase: 'page:screenshot', message: '保存页面截图' });
  await page.screenshot({ path: screenshotPath, fullPage: true });

  emit({ phase: 'page:evaluate', message: '采集 DOM、样式和元素位置' });
  const data = await page.evaluate(() => {
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
        .replace(/\s+/g, ' ')
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
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts = [];
      let node = el;
      while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
        let part = node.tagName.toLowerCase();
        const classNames = Array.from(node.classList || [])
          .filter((name) => !/^css-|^ng-|^_/.test(name))
          .slice(0, 2);
        if (classNames.length) part += classNames.map((name) => `.${CSS.escape(name)}`).join('');
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
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
      const label = `${tag} ${role} ${cls} ${text}`;
      const hints = [];

      if (/button|btn/i.test(label) || /^(确定|取消|保存|提交|删除|新增|新建|查询|搜索|导出|导入|修改|编辑|重置|开始检测|查看报告)$/.test(text)) hints.push('button');
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
      const label = `${tag} ${role} ${cls}`;
      if (/table|datatable|grid|treegrid|row|cell|column|toolbar|ttoolbar|form|search|pagination|pager|checkbox|radio|switch|input|select|btn|button|px-ui|plx-/i.test(label)) return true;
      if (['tr', 'td', 'th', 'label'].includes(tag)) return true;
      if (style.borderWidth !== '0px' && style.borderStyle !== 'none') return true;
      return false;
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
      .slice(0, 2000);

    const bodyStyle = styleOf(document.body);
    const htmlStyle = styleOf(document.documentElement);

    return {
      title: document.title,
      url: location.href,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio
      },
      pageStyle: {
        body: bodyStyle,
        html: htmlStyle
      },
      elements,
      domSnapshotPruned: buildDomSnapshot()
    };
  });

  const result = {
    ok: true,
    collectedAt: new Date().toISOString(),
    requestedUrl: url,
    finalUrl: data.url,
    manualLogin,
    screenshot: screenshotPath,
    ...data
  };

  const snapshotPaths = domSnapshotPaths(outPath);
  await fs.writeFile(snapshotPaths.raw, '<!doctype html>\n' + (await page.content()), 'utf8');
  await fs.writeFile(snapshotPaths.pruned, String(data.domSnapshotPruned || ''), 'utf8');
  result.domSnapshot = {
    rawPath: snapshotPaths.raw,
    prunedPath: snapshotPaths.pruned
  };
  delete result.domSnapshotPruned;

  const dispose = async () => {
    if (context) await context.close();
    if (browser) await browser.close();
  };

  if (options.preserveSession) {
    Object.defineProperty(result, '__session', {
      value: { page, context, browser, dispose },
      enumerable: false,
      configurable: true
    });
  } else {
    await dispose();
  }

  await fs.writeFile(outPath, JSON.stringify(result, null, 2), 'utf8');
  emit({ phase: 'collector:done', message: '运行态采集完成', out: outPath, screenshot: screenshotPath, elements: result.elements.length });
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = getCliOption('url');
  collectRuntimeUi({
    url,
    out: getCliOption('out'),
    screenshot: getCliOption('screenshot'),
    viewport: getCliOption('viewport'),
    waitUntil: getCliOption('waitUntil')
    ,
    ignoreHTTPSErrors: parseBoolean(getCliOption('ignoreHTTPSErrors'), true),
    manualLogin: parseBoolean(getCliOption('manualLogin'), false),
    manualWaitMs: Number(getCliOption('manualWaitMs', 90000)),
    userDataDir: getCliOption('userDataDir')
  }).catch((error) => {
    emit({ phase: 'collector:error', message: error?.message || String(error), stack: error?.stack });
    process.exit(1);
  });
}
