import fs from 'node:fs/promises';
import path from 'node:path';

const profile = String(process.argv[2] || '').trim().toLowerCase();
const profiles = {
  external: 'model-config.external-kimi.json',
  internal: 'model-config.internal-aione.json'
};

if (!profiles[profile]) {
  console.error('用法：node scripts/switch-model-config.mjs external|internal');
  process.exit(1);
}

const configDir = path.resolve('user-data/config');
const sourcePath = path.join(configDir, profiles[profile]);
const targetPath = path.join(configDir, 'model-config.json');
const raw = await fs.readFile(sourcePath, 'utf8');
JSON.parse(raw);
await fs.writeFile(targetPath, raw, 'utf8');
console.log(`模型配置已切换为 ${profile}：${sourcePath}`);
