import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { callJsonModel } from './model-client.mjs';

export const LAYOUT_RESULT_TEMPLATE = {
  auditFamily: 'layout',
  pagePattern: 'string|custom',
  confidence: 'number 0-1',
  issues: [{
    ruleId: 'LAYOUT.*',
    location: 'string',
    problem: '当前XXX，应该XXX',
    severity: 'low|medium|high',
    confidence: 'number 0-1'
  }],
  summary: '一句话'
};

const clamp = (value) => Math.max(0, Math.min(1, Number(value) || 0));

export function normalizeLayoutResult(value, mode) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    auditFamily: 'layout',
    mode: mode === 'image' ? 'image' : 'dom',
    pagePattern: String(source.pagePattern || 'custom').slice(0, 80),
    confidence: clamp(source.confidence),
    issues: (Array.isArray(source.issues) ? source.issues : []).map((issue) => ({
      ruleId: String(issue?.ruleId || ''),
      location: String(issue?.location || ''),
      problem: String(issue?.problem || ''),
      severity: ['low', 'medium', 'high'].includes(issue?.severity) ? issue.severity : 'low',
      confidence: clamp(issue?.confidence)
    })).filter((issue) => /^LAYOUT\./.test(issue.ruleId) && issue.location && issue.problem),
    summary: String(source.summary || '').slice(0, 120)
  };
}

function mime(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  return 'image/png';
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function prompt(mode) {
  return [
    '你是 UXChecker 的整页布局验收员。本轮只检查空间布局，不检查颜色、字体、圆角或单个组件外观。',
    '先识别证据中实际存在的页面区域，再逐条应用规范中 appliesWhen 成立的原子规则；页面不需要匹配任何固定参考稿。',
    mode === 'dom'
      ? '使用冻结 DOM 中的 bbox 与 computed style 判断位置、尺寸、间距和对齐；这份快照已经脱离登录态，不得请求登录或外部资源。'
      : '使用图片判断明显的对齐、间距一致性、分组、溢出和栅格关系；看不清精确像素时不得编造数值。',
    '不存在的可选区域不报问题。一个实际空间关系只报一次。证据不足不报。',
    mode === 'dom'
      ? 'location 写“用户可理解的位置，代码位置（CSS selector 或 DOM 路径）”。'
      : 'location 写“用户可理解的位置，图片区域（左/中/右、上/中/下）”。',
    '只输出严格 JSON，不要解释、markdown 或前后缀。'
  ].join('\n');
}

function compactLayoutDom(html) {
  const nodes = [];
  for (const match of String(html).matchAll(/<[^!][^>]*data-ux-box=["'][^"']+["'][^>]*>/g)) {
    nodes.push(match[0]);
    if (nodes.join('\n').length > 160000) break;
  }
  return nodes.join('\n');
}

export async function auditLayout(options) {
  const mode = options.mode === 'image' ? 'image' : 'dom';
  const [standard, evidence] = await Promise.all([
    fs.readFile(options.standardPath, 'utf8'),
    fs.readFile(options.evidencePath)
  ]);
  const payload = {
    task: '按照自包含布局规范验收当前页面的空间关系',
    standard: JSON.parse(standard),
    requiredOutput: LAYOUT_RESULT_TEMPLATE
  };
  const userContent = mode === 'image'
    ? [
        { type: 'text', text: JSON.stringify(payload) },
        { type: 'image_url', image_url: { url: `data:${mime(options.evidencePath)};base64,${evidence.toString('base64')}` } }
      ]
    : JSON.stringify({
        ...payload,
        evidenceNote: '从完整冻结DOM生成的布局证据，保留元素标签、class、computed style与data-ux-box；完整快照在本地留档。',
        domSnapshot: compactLayoutDom(evidence.toString('utf8'))
      });
  const response = await callJsonModel({
    config: options.config,
    fetchImpl: options.fetchImpl,
    onProgress: options.onProgress,
    maxTokens: 3200,
    system: prompt(mode),
    userContent,
    schemaHint: LAYOUT_RESULT_TEMPLATE
  });
  const result = normalizeLayoutResult(response.parsed, mode);
  let requestManifestPath = null;
  let rawResponsePath = null;
  if (options.artifactDir) {
    await fs.mkdir(options.artifactDir, { recursive: true });
    requestManifestPath = path.join(options.artifactDir, 'layout-request-manifest.json');
    rawResponsePath = path.join(options.artifactDir, 'layout-raw-response.json');
    await fs.writeFile(requestManifestPath, JSON.stringify({
      createdAt: new Date().toISOString(),
      mode,
      evidencePath: options.evidencePath,
      evidenceBytes: evidence.length,
      evidenceSha256: hash(evidence),
      standardPath: options.standardPath,
      standardBytes: Buffer.byteLength(standard),
      standardSha256: hash(standard),
      model: response.model,
      usage: response.usage
    }, null, 2));
    await fs.writeFile(rawResponsePath, JSON.stringify({
      createdAt: new Date().toISOString(),
      model: response.model,
      content: response.responseContent
    }, null, 2));
  }
  return { result, model: response.model, usage: response.usage, requestManifestPath, rawResponsePath };
}
