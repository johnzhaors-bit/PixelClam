import fs from 'node:fs/promises';
import path from 'node:path';

const STYLE_PROPERTIES = [
  'display', 'position', 'visibility', 'opacity', 'box-sizing', 'width', 'height',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'gap', 'row-gap', 'column-gap', 'color', 'background-color', 'border',
  'border-top-width', 'border-top-style', 'border-top-color',
  'border-right-width', 'border-right-style', 'border-right-color',
  'border-bottom-width', 'border-bottom-style', 'border-bottom-color',
  'border-left-width', 'border-left-style', 'border-left-color',
  'border-radius', 'box-shadow', 'font-family', 'font-size', 'font-weight',
  'line-height', 'letter-spacing', 'text-align',
  'text-decoration-line', 'text-decoration-style', 'text-decoration-color',
  'vertical-align', 'cursor', 'pointer-events', 'z-index'
];

export async function freezeWebContents(webContents, options = {}) {
  const outDir = path.resolve(options.outDir);
  await fs.mkdir(outDir, { recursive: true });
  const screenshotPath = path.join(outDir, 'screenshot.png');
  const snapshotPath = path.join(outDir, 'dom-snapshot.html');
  const modelSnapshotPath = path.join(outDir, 'dom-evidence.html');
  const image = await webContents.capturePage();
  await fs.writeFile(screenshotPath, image.toPNG());

  const source = `(${async function freeze(styleProperties) {
    async function asDataUrl(url) {
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
      } catch { return url; }
    }
    const clone = document.documentElement.cloneNode(true);
    const originals = [document.documentElement, ...document.documentElement.querySelectorAll('*')];
    const clones = [clone, ...clone.querySelectorAll('*')];
    clones.forEach((node, index) => {
      const original = originals[index];
      if (!original) return;
      const computed = getComputedStyle(original);
      const rect = original.getBoundingClientRect();
      node.setAttribute('style', styleProperties.map((name) => name + ':' + computed.getPropertyValue(name)).join(';'));
      node.setAttribute('data-ux-box', [rect.x, rect.y, rect.width, rect.height].map(Math.round).join(','));
      node.setAttribute('data-ux-visible', rect.width > 0 && rect.height > 0 && computed.display !== 'none' && computed.visibility !== 'hidden' ? 'true' : 'false');
      Array.from(node.attributes || []).forEach((attr) => {
        if (attr.name.toLowerCase().startsWith('on')) node.removeAttribute(attr.name);
      });
    });
    clone.querySelectorAll('script,noscript,base').forEach((node) => node.remove());
    const controls = Array.from(document.querySelectorAll('input,textarea,select'));
    Array.from(clone.querySelectorAll('input,textarea,select')).forEach((node, index) => {
      const original = controls[index];
      if (!original) return;
      if (node.tagName === 'TEXTAREA') node.textContent = original.value;
      if (node.tagName === 'INPUT') {
        node.setAttribute('value', original.type === 'password' ? '' : original.value);
        if (original.checked) node.setAttribute('checked', ''); else node.removeAttribute('checked');
      }
      if (node.tagName === 'SELECT') Array.from(node.options).forEach((option, i) => {
        if (original.options[i]?.selected) option.setAttribute('selected', ''); else option.removeAttribute('selected');
      });
    });
    const originalImages = Array.from(document.querySelectorAll('img'));
    const clonedImages = Array.from(clone.querySelectorAll('img'));
    await Promise.all(clonedImages.map(async (node, index) => {
      node.setAttribute('src', await asDataUrl(originalImages[index]?.currentSrc || originalImages[index]?.src || ''));
      node.removeAttribute('srcset');
    }));
    const unresolved = clonedImages.map((node) => node.getAttribute('src') || '').filter((url) => /^https?:/i.test(url));
    const modelClone = clone.cloneNode(true);
    modelClone.querySelectorAll('[data-ux-visible="false"]').forEach((node) => node.remove());
    modelClone.querySelectorAll('link,meta,svg defs').forEach((node) => node.remove());
    return {
      html: '<!doctype html>\n' + clone.outerHTML,
      modelHtml: '<!doctype html>\n' + modelClone.outerHTML.replace(/>\s+</g, '><'),
      title: document.title,
      url: location.href,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      freezeSummary: { elementCount: clones.length, unresolvedResourceCount: unresolved.length, unresolvedResources: unresolved.slice(0, 20) }
    };
  }})(${JSON.stringify(STYLE_PROPERTIES)})`;
  const snapshot = await webContents.executeJavaScript(source, true);
  await fs.writeFile(snapshotPath, snapshot.html, 'utf8');
  await fs.writeFile(modelSnapshotPath, snapshot.modelHtml, 'utf8');
  const snapshotBytes = Buffer.byteLength(snapshot.html, 'utf8');
  const modelSnapshotBytes = Buffer.byteLength(snapshot.modelHtml, 'utf8');
  await fs.writeFile(path.join(outDir, 'snapshot-manifest.json'), JSON.stringify({
    title: snapshot.title,
    url: snapshot.url,
    viewport: snapshot.viewport,
    freezeSummary: { ...snapshot.freezeSummary, snapshotBytes, modelSnapshotBytes }
  }, null, 2), 'utf8');
  return { ...snapshot, snapshotPath, modelSnapshotPath, screenshotPath };
}
