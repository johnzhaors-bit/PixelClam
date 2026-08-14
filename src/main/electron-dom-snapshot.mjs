import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  'vertical-align', 'cursor', 'pointer-events', 'z-index', 'fill', 'stroke',
  'filter', 'object-fit', 'object-position', 'background-image', 'mask-image'
];

const SMALL_RASTER_BYTES = 32 * 1024;
const SMALL_VECTOR_BYTES = 64 * 1024;

function decodeQuotedPrintable(value) {
  const binary = String(value || '')
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  return Buffer.from(binary, 'latin1').toString('utf8');
}

function resourceFilename(value) {
  const clean = String(value || '').split(/[?#]/, 1)[0];
  try {
    const pathname = new URL(clean, 'https://ux.local/').pathname;
    return decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1)) || 'unnamed-image';
  } catch {
    return clean.slice(clean.lastIndexOf('/') + 1) || 'unnamed-image';
  }
}

function decodeMimeBody(body, encoding) {
  if (/base64/i.test(encoding)) return Buffer.from(String(body || '').replace(/\s/g, ''), 'base64');
  if (/quoted-printable/i.test(encoding)) return Buffer.from(decodeQuotedPrintable(body), 'utf8');
  return Buffer.from(String(body || ''), 'utf8');
}

export function extractHtmlFromMhtml(rawMhtml) {
  const boundary = rawMhtml.match(/boundary="?([^"\r\n;]+)"?/i)?.[1];
  if (!boundary) return rawMhtml;
  const parts = rawMhtml.split(`--${boundary}`).map((part) => {
    const separator = part.match(/\r?\n\r?\n/);
    if (!separator) return null;
    const splitAt = separator.index;
    const headers = part.slice(0, splitAt);
    const body = part.slice(splitAt + separator[0].length).replace(/\r?\n$/, '');
    const contentType = headers.match(/Content-Type:\s*([^;\r\n]+)/i)?.[1]?.trim().toLowerCase() || '';
    const location = headers.match(/Content-Location:\s*([^\r\n]+)/i)?.[1]?.trim() || '';
    const encoding = headers.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i)?.[1]?.trim() || '';
    return { headers, body, contentType, location, encoding };
  }).filter(Boolean);
  const htmlPart = parts.find((part) => part.contentType === 'text/html');
  if (!htmlPart) return rawMhtml;
  let html = /quoted-printable/i.test(htmlPart.encoding)
    ? decodeQuotedPrintable(htmlPart.body)
    : htmlPart.body;
  const imageResources = new Map(parts
    .filter((part) => /^image\//i.test(part.contentType) && part.location)
    .map((part) => [part.location, { ...part, bytes: decodeMimeBody(part.body, part.encoding) }]));
  html = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const srcMatch = tag.match(/\bsrc\s*=\s*(["'])(.*?)\1/i);
    const src = srcMatch?.[2] || '';
    const filename = resourceFilename(src);
    const resource = imageResources.get(src);
    const extension = src.match(/\.([a-z0-9]+)(?:$|[?#])/i)?.[1]?.toLowerCase() || '';
    const inferredMime = extension === 'svg' ? 'image/svg+xml'
      : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
        : extension ? `image/${extension}` : 'unknown';
    const mimeType = resource?.contentType || inferredMime;
    const byteLength = resource?.bytes?.length || 0;
    const retainLimit = /svg/i.test(String(mimeType)) ? SMALL_VECTOR_BYTES : SMALL_RASTER_BYTES;
    const retained = Boolean(resource && byteLength <= retainLimit);
    let next = tag.replace(/\sdata-ux-image-[\w-]+=(?:"[^"]*"|'[^']*')/gi, '');
    if (srcMatch) {
      const replacement = retained
        ? `src="data:${resource.contentType};base64,${resource.bytes.toString('base64')}"`
        : 'src=""';
      next = next.replace(srcMatch[0], replacement);
    }
    return next.replace(/>$/, ` data-ux-image-name="${filename.replace(/"/g, '&quot;')}" data-ux-image-type="${String(mimeType)}" data-ux-image-bytes="${byteLength}" data-ux-image-resource="${retained ? 'retained' : 'omitted'}">`);
  });
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .trim();
}

export async function freezeWebContents(webContents, options = {}) {
  const outDir = path.resolve(options.outDir);
  await fs.mkdir(outDir, { recursive: true });
  const screenshotPath = path.join(outDir, 'screenshot.png');
  const snapshotPath = path.join(outDir, 'dom-snapshot.html');
  const modelSnapshotPath = path.join(outDir, 'dom-evidence.html');
  const image = await webContents.capturePage();
  await fs.writeFile(screenshotPath, image.toPNG());

  const source = `(${async function freeze(styleProperties, smallRasterBytes, smallVectorBytes) {
    const warnings = [];
    function filenameOf(url) {
      try {
        const pathname = new URL(url, location.href).pathname;
        return decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1)) || 'unnamed-image';
      } catch { return 'unnamed-image'; }
    }
    async function imageEvidence(url, displayWidth, displayHeight) {
      const base = { src: '', filename: filenameOf(url), mimeType: '', bytes: 0, retained: false };
      if (!url || /^(about:|javascript:)/i.test(url)) return base;
      if (/^data:/i.test(url)) return { ...base, src: url, mimeType: url.slice(5, url.indexOf(';') > 0 ? url.indexOf(';') : url.indexOf(',')), retained: true };
      try {
        const response = await fetch(new URL(url, location.href).href, { credentials: 'include' });
        if (!response.ok) return base;
        const blob = await response.blob();
        const isVector = /svg/i.test(blob.type) || /\.svg(?:$|[?#])/i.test(url);
        const limit = isVector ? smallVectorBytes : smallRasterBytes;
        const iconSized = displayWidth <= 64 && displayHeight <= 64;
        const retained = blob.size <= limit && (iconSized || isVector);
        if (!retained) return { ...base, mimeType: blob.type, bytes: blob.size, retained: false };
        const src = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        return { ...base, src, mimeType: blob.type, bytes: blob.size, retained: true };
      } catch { return base; }
    }
    const clone = document.documentElement.cloneNode(true);
    const originals = [document.documentElement, ...document.documentElement.querySelectorAll('*')];
    const clones = [clone, ...clone.querySelectorAll('*')];
    clones.forEach((node, index) => {
      const original = originals[index];
      if (!original) return;
      try {
        const computed = getComputedStyle(original);
        const rect = original.getBoundingClientRect();
        node.setAttribute('style', styleProperties.map((name) => name + ':' + computed.getPropertyValue(name)).join(';'));
        node.setAttribute('data-ux-box', [rect.x, rect.y, rect.width, rect.height].map(Math.round).join(','));
        node.setAttribute('data-ux-visible', rect.width > 0 && rect.height > 0 && computed.display !== 'none' && computed.visibility !== 'hidden' ? 'true' : 'false');
        Array.from(node.attributes || []).forEach((attr) => {
          if (attr.name.toLowerCase().startsWith('on')) node.removeAttribute(attr.name);
        });
      } catch (error) {
        if (warnings.length < 20) warnings.push('element ' + index + ': ' + String(error?.message || error));
      }
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
      const original = originalImages[index];
      const rect = original?.getBoundingClientRect?.() || { width: 0, height: 0 };
      const evidence = await imageEvidence(original?.currentSrc || original?.src || '', rect.width, rect.height);
      node.setAttribute('src', evidence.src);
      node.removeAttribute('srcset');
      node.setAttribute('data-ux-image-name', evidence.filename);
      node.setAttribute('data-ux-image-type', evidence.mimeType || 'unknown');
      node.setAttribute('data-ux-image-bytes', String(evidence.bytes));
      node.setAttribute('data-ux-image-resource', evidence.retained ? 'retained' : 'omitted');
      node.setAttribute('data-ux-image-display-size', Math.round(rect.width) + 'x' + Math.round(rect.height));
      node.setAttribute('data-ux-image-natural-size', String(original?.naturalWidth || 0) + 'x' + String(original?.naturalHeight || 0));
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
      freezeSummary: { elementCount: clones.length, unresolvedResourceCount: unresolved.length, unresolvedResources: unresolved.slice(0, 20), warnings }
    };
  }})(${JSON.stringify(STYLE_PROPERTIES)}, ${SMALL_RASTER_BYTES}, ${SMALL_VECTOR_BYTES})`;
  let snapshot;
  try {
    snapshot = await webContents.executeJavaScript(source, true);
  } catch (richSnapshotError) {
    // Chromium may block complex injected async scripts for some saved MHTML
    // documents. Keep DOM mode usable by falling back to the already rendered
    // document; the screenshot remains available as auxiliary evidence.
    const fallbackSource = `(() => {
      const root = document.documentElement;
      if (!root) return { error: 'document.documentElement is unavailable' };
      const clone = root.cloneNode(true);
      clone.querySelectorAll('script,noscript,base').forEach((node) => node.remove());
      clone.querySelectorAll('input,textarea,select').forEach((node) => {
        if (node.tagName === 'INPUT' && String(node.getAttribute('type') || '').toLowerCase() === 'password') node.setAttribute('value', '');
        Array.from(node.attributes || []).forEach((attr) => {
          if (attr.name.toLowerCase().startsWith('on')) node.removeAttribute(attr.name);
        });
      });
      const html = '<!doctype html>\\n' + clone.outerHTML;
      return {
        html,
        modelHtml: html.replace(/>\\s+</g, '><'),
        title: document.title,
        url: location.href,
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        freezeSummary: {
          elementCount: clone.querySelectorAll('*').length + 1,
          unresolvedResourceCount: 0,
          unresolvedResources: [],
          fallback: true,
          warnings: ['Rich computed-style snapshot failed: ' + ${JSON.stringify('PLACEHOLDER')}]
        }
      };
    })()`;
    const safeMessage = String(richSnapshotError?.message || richSnapshotError).slice(0, 500);
    try {
      snapshot = await webContents.executeJavaScript(fallbackSource.replace(JSON.stringify('PLACEHOLDER'), JSON.stringify(safeMessage)), true);
      if (snapshot?.error) throw new Error(`DOM fallback snapshot failed: ${snapshot.error}`);
    } catch (simpleSnapshotError) {
      const currentUrl = webContents.getURL();
      if (!/^file:\/\//i.test(currentUrl) || !/\.mhtml?(?:$|[?#])/i.test(currentUrl)) throw simpleSnapshotError;
      const rawMhtml = await fs.readFile(fileURLToPath(currentUrl), 'utf8');
      const archivedHtml = extractHtmlFromMhtml(rawMhtml);
      const imageSize = image.getSize();
      snapshot = {
        html: archivedHtml,
        modelHtml: archivedHtml.replace(/>\s+</g, '><'),
        title: webContents.getTitle() || path.basename(fileURLToPath(currentUrl), path.extname(fileURLToPath(currentUrl))),
        url: currentUrl,
        viewport: { width: imageSize.width, height: imageSize.height, devicePixelRatio: null },
        freezeSummary: {
          elementCount: null,
          unresolvedResourceCount: 0,
          unresolvedResources: [],
          fallback: 'mhtml-source',
          warnings: [
            `Rich computed-style snapshot failed: ${safeMessage}`,
            `Simple DOM snapshot failed: ${String(simpleSnapshotError?.message || simpleSnapshotError).slice(0, 500)}`
          ]
        }
      };
    }
  }
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
