#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function getCliOption(name, fallback = '') {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length).trim() || fallback : fallback;
}

function normalizeUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^(https?|file):\/\//i.test(text)) return text;
  return `https://${text}`;
}

function parseViewport(value) {
  const match = String(value || '').match(/^(\d+)x(\d+)$/);
  if (!match) return { width: 1440, height: 900 };
  return { width: Number(match[1]), height: Number(match[2]) };
}

function compactText(value, maxLength = 12000) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)} ...<truncated>` : text;
}

function stripCodeFence(text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractBalancedJsonObject(text) {
  const source = stripCodeFence(text);
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          return source.slice(start, index + 1);
        }
      }
    }
  }

  return source;
}

function parseLooseJson(text) {
  const source = stripCodeFence(text);
  try {
    return JSON.parse(source);
  } catch {
    return JSON.parse(extractBalancedJsonObject(source));
  }
}

async function loadPlaywright() {
  const moduleUrl = pathToFileURL(path.join(projectRoot, 'node_modules', 'playwright', 'index.mjs')).href;
  return import(moduleUrl);
}

async function loadModelConfig() {
  const configPath = '/Users/a10146331/Documents/AI Design QA Platform/UXChecker-2/user-data/config/model-config.json';
  const raw = await fs.readFile(configPath, 'utf8');
  return JSON.parse(raw);
}

async function loadButtonSpec() {
  const specPath = path.join(
    projectRoot,
    'user-data',
    'skills',
    'Paletx-MultiSkin-Audit',
    'standards',
    'paletx-core',
    'components',
    'button.md'
  );
  return fs.readFile(specPath, 'utf8');
}

function ensureMoonshotTemperature(config) {
  const baseUrl = String(config.baseUrl || '').toLowerCase();
  const model = String(config.model || '').toLowerCase();
  if (baseUrl.includes('api.moonshot.cn') && model.startsWith('kimi-k3')) {
    return 1;
  }
  return Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : 0.6;
}

async function callKimiForButtonAudit({ config, htmlSnapshot, buttonSpec, screenshotDataUrl, outDir }) {
  const payload = {
    model: config.model,
    temperature: ensureMoonshotTemperature(config),
    max_tokens: 2500,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: [
          '你是一个前端 UX 组件验收助手。',
          '这次只做一个任务：识别页面中疑似按钮的对象，并根据给定的 PaletX 按钮规范判断它们更接近哪种按钮，以及是否存在明显不符合规范的问题。',
          '不要检查布局，不要检查表格，不要检查输入框，只聚焦按钮。',
          '如果证据不足，要明确说明证据不足，不要编造。',
          '输出必须是 JSON 对象。',
          '不要写自然语言段落，不要写解释，不要写前后缀，只允许填写模板字段。'
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              '下面是按钮规范摘录：',
              compactText(buttonSpec, 9000),
              '',
              '下面是页面冻结后的运行态 HTML 快照（已压缩，保留结构与文本）：',
              compactText(htmlSnapshot, 50000),
              '',
              '如果截图有帮助，可以参考这张整页压缩图，但仍然以 HTML 结构为主：',
              '',
              '请输出 JSON，格式如下：',
              '{',
              '  "candidateButtons": [',
              '    {',
              '      "componentName": "组件名称，优先用按钮文字，如：确定按钮/删除按钮/导出按钮",',
              '      "matchedVariant": "primary|default|danger|guide|icon|unknown",',
              '      "confidence": 0-1,',
              '      "issues": [',
              '        {',
              '          "location": "相对位置 + 代码位置，例如：表格左上方，代码位置（.toolbar button:nth-of-type(1)）",',
              '          "problem": "严格使用这个句式：当前XXX，应该XXX；当前XXX，应该XXX",',
              '          "severity": "low|medium|high"',
              '        }',
              '      ]',
              '    }',
              '  ],',
              '  "summary": "一句话总结，最多 40 个字"',
              '}',
              '',
              '额外要求：',
              '1. 只允许填写上述 JSON 字段，不要增加其他字段。',
              '2. 如果某个按钮没有明确问题，issues 可以为空数组。',
              '3. 不要写“建议关注”“可能”“大概”等模糊表述。',
              '4. location 一定要带代码位置（...）。',
              '5. problem 一定写成“当前XXX，应该XXX”的对照句。'
            ].join('\n')
          },
          {
            type: 'image_url',
            image_url: {
              url: screenshotDataUrl
            }
          }
        ]
      }
    ]
  };

  const response = await fetch(`${String(config.baseUrl || '').replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  if (outDir) {
    await fs.writeFile(path.join(outDir, 'model-raw-response.json'), text, 'utf8');
  }
  if (!response.ok) {
    throw new Error(`模型请求失败：HTTP ${response.status} ${text}`);
  }
  const payloadResponse = JSON.parse(text);
  const content = payloadResponse?.choices?.[0]?.message?.content || '';
  const reasoningContent = payloadResponse?.choices?.[0]?.message?.reasoning_content || '';
  if (outDir) {
    await fs.writeFile(path.join(outDir, 'model-message-content.txt'), String(content), 'utf8');
    await fs.writeFile(path.join(outDir, 'model-reasoning-content.txt'), String(reasoningContent), 'utf8');
  }
  if (String(content || '').trim()) {
    return parseLooseJson(content);
  }
  if (String(reasoningContent || '').trim()) {
    return callKimiToStructureReasoning({ config, reasoningContent, outDir });
  }
  throw new Error('模型未返回可用 content，也未返回 reasoning_content');
}

async function callKimiToStructureReasoning({ config, reasoningContent, outDir }) {
  const payload = {
    model: config.model,
    temperature: ensureMoonshotTemperature(config),
    max_tokens: 3000,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: [
          '你是一个 JSON 整理器。',
          '把给定的按钮验收分析文本整理成严格 JSON。',
          '不要补充新事实，只能整理已有分析。',
          '输出必须是 JSON 对象。',
          '不要写自然语言段落，不要写解释，不要写前后缀，只允许填写模板字段。'
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          '请把下面文本整理成 JSON：',
          '',
          reasoningContent,
          '',
          'JSON 格式如下：',
          '{',
          '  "candidateButtons": [',
          '    {',
          '      "componentName": "组件名称，优先用按钮文字，如：确定按钮/删除按钮/导出按钮",',
          '      "matchedVariant": "primary|default|danger|guide|icon|unknown",',
          '      "confidence": 0-1,',
          '      "issues": [',
          '        {',
          '          "location": "相对位置 + 代码位置，例如：表格左上方，代码位置（.toolbar button:nth-of-type(1)）",',
          '          "problem": "严格使用这个句式：当前XXX，应该XXX；当前XXX，应该XXX",',
          '          "severity": "low|medium|high"',
          '        }',
          '      ]',
          '    }',
          '  ],',
          '  "summary": "一句话总结，最多 40 个字"',
          '}',
          '',
          '要求：',
          '1. 把能明确判断的问题都列出来；如果某项只是“证据不足”，不要写进 issues。',
          '2. issues 可以为空数组。',
          '3. 只能填模板字段，不要补充说明文字。',
          '4. location 一定保留“代码位置（...）”。',
          '5. problem 一定保留“当前XXX，应该XXX”的句式。'
        ].join('\n')
      }
    ]
  };

  const response = await fetch(`${String(config.baseUrl || '').replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  if (outDir) {
    await fs.writeFile(path.join(outDir, 'model-structuring-response.json'), text, 'utf8');
  }
  if (!response.ok) {
    throw new Error(`模型二次整理失败：HTTP ${response.status} ${text}`);
  }
  const payloadResponse = JSON.parse(text);
  const content = payloadResponse?.choices?.[0]?.message?.content || payloadResponse?.choices?.[0]?.message?.reasoning_content || '';
  if (outDir) {
    await fs.writeFile(path.join(outDir, 'model-structuring-content.txt'), String(content), 'utf8');
  }
  return parseLooseJson(content);
}

async function main() {
  const url = normalizeUrl(getCliOption('url', ''));
  if (!url) {
    throw new Error('缺少 --url=');
  }

  const viewport = parseViewport(getCliOption('viewport', '1440x900'));
  const outDir = path.resolve(getCliOption('out', path.join('/Users/a10146331/Documents/AI Design QA Platform/UXChecker-2/user-data/runs', `dom-snapshot-experiment-${Date.now()}`)));
  await fs.mkdir(outDir, { recursive: true });

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport });

  try {
    await page.goto(url, { waitUntil: 'load', timeout: 120000 });
    await page.waitForTimeout(1200);

    const rawHtml = await page.content();
    const prunedHtml = await page.evaluate(() => {
      const clone = document.documentElement.cloneNode(true);
      clone.querySelectorAll('script,noscript').forEach((node) => node.remove());
      clone.querySelectorAll('*').forEach((node) => {
        for (const attr of Array.from(node.attributes)) {
          const name = attr.name.toLowerCase();
          if (name.startsWith('on')) node.removeAttribute(attr.name);
          if (name === 'style' && String(attr.value || '').length > 800) {
            node.setAttribute('style', String(attr.value).slice(0, 800));
          }
        }
      });
      return '<!doctype html>\n' + clone.outerHTML;
    });

    const outline = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('button, a, input, select, textarea, [role], [class*="btn" i], [class*="button" i]'));
      return nodes.slice(0, 200).map((el, index) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return {
          index: index + 1,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          text: (el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
          id: el.id || '',
          className: String(el.className || '').slice(0, 160),
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          },
          style: {
            color: style.color,
            backgroundColor: style.backgroundColor,
            borderRadius: style.borderRadius,
            borderWidth: style.borderWidth,
            fontSize: style.fontSize,
            lineHeight: style.lineHeight
          }
        };
      });
    });

    const screenshotPath = path.join(outDir, 'page.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const screenshotBase64 = await fs.readFile(screenshotPath, 'base64');
    const screenshotDataUrl = `data:image/png;base64,${screenshotBase64}`;

    const rawHtmlPath = path.join(outDir, 'dom-snapshot.raw.html');
    const prunedHtmlPath = path.join(outDir, 'dom-snapshot.pruned.html');
    const outlinePath = path.join(outDir, 'dom-outline.json');

    await fs.writeFile(rawHtmlPath, rawHtml, 'utf8');
    await fs.writeFile(prunedHtmlPath, prunedHtml, 'utf8');
    await fs.writeFile(outlinePath, JSON.stringify(outline, null, 2), 'utf8');

    const [rawStat, prunedStat, screenshotStat] = await Promise.all([
      fs.stat(rawHtmlPath),
      fs.stat(prunedHtmlPath),
      fs.stat(screenshotPath)
    ]);

    const config = await loadModelConfig();
    const buttonSpec = await loadButtonSpec();
    const aiResult = await callKimiForButtonAudit({
      config,
      htmlSnapshot: prunedHtml,
      buttonSpec,
      screenshotDataUrl,
      outDir
    });

    const summary = {
      url,
      viewport,
      files: {
        rawHtmlPath,
        prunedHtmlPath,
        outlinePath,
        screenshotPath
      },
      sizes: {
        rawHtmlBytes: rawStat.size,
        prunedHtmlBytes: prunedStat.size,
        screenshotBytes: screenshotStat.size
      },
      aiResult
    };

    await fs.writeFile(path.join(outDir, 'experiment-result.json'), JSON.stringify(summary, null, 2), 'utf8');
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
