import fs from 'node:fs/promises';
import path from 'node:path';
import { callJsonModel } from '../src/main/model-client.mjs';

const root = path.resolve('.');
const runDir = path.join(root, 'user-data/runs/compare-full-vs-focused-dom-20260812');
const domPath = path.join(root, 'user-data/runs/20260812080928/dom-evidence.html');
const standardPath = path.join(root, 'user-data/skills/Paletx-MultiSkin-Audit/standards/component-packs-v3/skins/default/components/button.json');
const configPath = path.join(root, 'user-data/config/model-config.external-kimi.json');
const [dom, standardText, config] = await Promise.all([
  fs.readFile(domPath, 'utf8'),
  fs.readFile(standardPath, 'utf8'),
  fs.readFile(configPath, 'utf8').then(JSON.parse)
]);

await fs.mkdir(runDir, { recursive: true });

function buttonEvidence(html) {
  const matches = [];
  for (const match of html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/gi)) matches.push(match[0]);
  return matches.join('\n').slice(0, 120000);
}

const focusedDom = buttonEvidence(dom);
const common = {
  config,
  maxTokens: 1200,
  reasoningEffort: 'low',
  system: '你是按钮规范验收员。必须读取提供的DOM证据并比较computed style。只输出严格JSON。',
  schemaHint: { evidenceReceived: true, observedPrimaryColor: 'string', expectedPrimaryColor: 'string', issues: [] }
};

for (const [name, evidence] of [['full', dom], ['focused', focusedDom]]) {
  const progress = [];
  const response = await callJsonModel({
    ...common,
    onProgress: (event) => progress.push(event),
    userContent: JSON.stringify({
      task: '检查DOM中的自研主按钮。特别核对实际背景色与晴空蓝规范主色；发现 #0077FF 与 #1993FF 不一致时必须输出问题。',
      standard: standardText,
      domEvidence: evidence,
      requiredOutput: common.schemaHint
    })
  });
  await fs.writeFile(path.join(runDir, `${name}-result.json`), JSON.stringify({
    evidenceBytes: Buffer.byteLength(evidence),
    usage: response.usage,
    model: response.model,
    parsed: response.parsed,
    raw: response.responseContent,
    progress
  }, null, 2));
}

console.log(runDir);
