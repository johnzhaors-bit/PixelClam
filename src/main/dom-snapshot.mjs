import fs from 'node:fs/promises';
import path from 'node:path';

const STYLE_PROPERTIES = [
  'display', 'position', 'visibility', 'opacity', 'box-sizing',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'gap', 'row-gap', 'column-gap',
  'color', 'background-color', 'border',
  'border-top-width', 'border-top-style', 'border-top-color',
  'border-right-width', 'border-right-style', 'border-right-color',
  'border-bottom-width', 'border-bottom-style', 'border-bottom-color',
  'border-left-width', 'border-left-style', 'border-left-color',
  'border-radius', 'box-shadow',
  'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
  'text-align', 'text-decoration-line', 'text-decoration-style', 'text-decoration-color',
  'vertical-align', 'cursor', 'pointer-events', 'z-index'
];

export async function freezePage(page, options = {}) {
  const outDir = path.resolve(options.outDir || 'runs/dom-audit');
  await fs.mkdir(outDir, { recursive: true });
  const screenshotPath = path.join(outDir, 'screenshot.png');
  const snapshotPath = path.join(outDir, 'dom-snapshot.html');
  const modelSnapshotPath = path.join(outDir, 'dom-evidence.html');

  await page.screenshot({ path: screenshotPath, fullPage: true });
  const snapshot = await page.evaluate(async (styleProperties) => {
    async function resourceAsDataUrl(url) {
      if (!url || /^(data:|blob:|about:|javascript:)/i.test(url)) return url;
      try {
        const response = await fetch(new URL(url, location.href).href, { credentials: 'include' });
        if (!response.ok) return url;
        const blob = await response.blob();
        return await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || url));
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      } catch {
        return url;
      }
    }

    const clone = document.documentElement.cloneNode(true);
    const originals = [document.documentElement, ...document.documentElement.querySelectorAll('*')];
    const clones = [clone, ...clone.querySelectorAll('*')];

    clones.forEach((node, index) => {
      const original = originals[index];
      if (!original) return;
      const computed = getComputedStyle(original);
      const rect = original.getBoundingClientRect();
      const frozenStyle = styleProperties
        .map((name) => `${name}:${computed.getPropertyValue(name)}`)
        .join(';');
      node.setAttribute('style', frozenStyle);
      node.setAttribute('data-ux-box', `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`);
      node.setAttribute('data-ux-visible', rect.width > 0 && rect.height > 0 && computed.display !== 'none' && computed.visibility !== 'hidden' ? 'true' : 'false');
      for (const attr of Array.from(node.attributes || [])) {
        if (attr.name.toLowerCase().startsWith('on')) node.removeAttribute(attr.name);
      }
    });

    clone.querySelectorAll('script,noscript').forEach((node) => node.remove());
    clone.querySelectorAll('base').forEach((node) => node.remove());

    const originalControls = Array.from(document.querySelectorAll('input,textarea,select'));
    const clonedControls = Array.from(clone.querySelectorAll('input,textarea,select'));
    clonedControls.forEach((node, index) => {
      const original = originalControls[index];
      if (!original) return;
      if (node instanceof HTMLTextAreaElement) node.textContent = original.value;
      if (node instanceof HTMLSelectElement) {
        Array.from(node.options).forEach((option, optionIndex) => {
          if (original.options[optionIndex]?.selected) option.setAttribute('selected', '');
          else option.removeAttribute('selected');
        });
      }
      if (node instanceof HTMLInputElement) {
        if (original.type !== 'password') node.setAttribute('value', original.value);
        else node.setAttribute('value', '');
        if (original.checked) node.setAttribute('checked', '');
        else node.removeAttribute('checked');
      }
    });

    const originalImages = Array.from(document.querySelectorAll('img'));
    const clonedImages = Array.from(clone.querySelectorAll('img'));
    await Promise.all(clonedImages.map(async (node, index) => {
      const original = originalImages[index];
      if (!original) return;
      const source = original.currentSrc || original.src;
      node.setAttribute('src', await resourceAsDataUrl(source));
      node.removeAttribute('srcset');
    }));

    const unresolvedResources = Array.from(clone.querySelectorAll('img'))
      .map((node) => node.getAttribute('src') || '')
      .filter((value) => /^https?:/i.test(value));
    const modelClone = clone.cloneNode(true);
    modelClone.querySelectorAll('[data-ux-visible="false"]').forEach((node) => node.remove());
    modelClone.querySelectorAll('link,meta,svg defs').forEach((node) => node.remove());
    return {
      html: '<!doctype html>\n' + clone.outerHTML,
      modelHtml: '<!doctype html>\n' + modelClone.outerHTML.replace(/>\s+</g, '><'),
      title: document.title,
      url: location.href,
      viewport: {
        width: innerWidth,
        height: innerHeight,
        devicePixelRatio
      },
      freezeSummary: {
        elementCount: clones.length,
        inlinedImageCount: clonedImages.length - unresolvedResources.length,
        unresolvedResourceCount: unresolvedResources.length,
        unresolvedResources: unresolvedResources.slice(0, 20),
        scriptsRemoved: true,
        authenticationRequiredAfterFreeze: false
      }
    };
  }, STYLE_PROPERTIES);

  await fs.writeFile(snapshotPath, snapshot.html, 'utf8');
  await fs.writeFile(modelSnapshotPath, snapshot.modelHtml, 'utf8');
  const snapshotBytes = Buffer.byteLength(snapshot.html, 'utf8');
  const modelSnapshotBytes = Buffer.byteLength(snapshot.modelHtml, 'utf8');
  await fs.writeFile(
    path.join(outDir, 'snapshot-manifest.json'),
    JSON.stringify({
      title: snapshot.title,
      url: snapshot.url,
      viewport: snapshot.viewport,
      freezeSummary: {
        ...snapshot.freezeSummary,
        snapshotBytes,
        modelSnapshotBytes
      }
    }, null, 2),
    'utf8'
  );
  return { ...snapshot, snapshotPath, modelSnapshotPath, screenshotPath };
}

export async function collectDomSnapshot(options = {}) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: options.headless !== false });
  try {
    const page = await browser.newPage({ viewport: options.viewport || { width: 1440, height: 900 } });
    await page.goto(options.url, { waitUntil: options.waitUntil || 'networkidle', timeout: options.timeoutMs || 60000 });
    return await freezePage(page, options);
  } finally {
    await browser.close();
  }
}
