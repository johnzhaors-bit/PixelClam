import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bootstrapRoot = path.join(appRoot, '.build-test-assets');
const variant = String(process.env.UXCHECKER_BUNDLE_VARIANT || 'public').trim().toLowerCase();
if (!['public', 'internal'].includes(variant)) throw new Error(`未知打包变体：${variant}`);

await fs.rm(bootstrapRoot, { recursive: true, force: true });
await fs.mkdir(path.join(bootstrapRoot, 'config'), { recursive: true });
await fs.mkdir(path.join(bootstrapRoot, 'skills'), { recursive: true });
const publicConfig = path.join(appRoot, 'config', 'model-config.example.json');
const internalConfig = path.join(appRoot, 'user-data', 'config', 'model-config.json');
const configSource = variant === 'internal' ? internalConfig : publicConfig;
if (variant === 'internal') {
  const config = JSON.parse(await fs.readFile(internalConfig, 'utf8'));
  if (!String(config.apiKey || '').trim()) throw new Error('内部包要求 user-data/config/model-config.json 包含有效 API Key');
}
await fs.copyFile(configSource, path.join(bootstrapRoot, 'config', 'model-config.json'));
if (variant === 'public' || process.env.UXCHECKER_BUNDLE_EXAMPLE_SKILL === '1') {
  await fs.cp(path.join(appRoot, 'user-data', 'skills', '示例规范'), path.join(bootstrapRoot, 'skills', '示例规范'), { recursive: true });
}
const includedSkills = [];
if (variant === 'public' || process.env.UXCHECKER_BUNDLE_EXAMPLE_SKILL === '1') includedSkills.push('示例规范');
if (variant === 'internal') {
  const localSkillsRoot = path.join(appRoot, 'user-data', 'skills');
  const privateSkillNames = (await fs.readdir(localSkillsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name !== '示例规范')
    .map((entry) => entry.name);
  if (!privateSkillNames.length) throw new Error('内部包没有找到本机私有 Skill');
  for (const skillName of privateSkillNames) {
    await fs.cp(path.join(localSkillsRoot, skillName), path.join(bootstrapRoot, 'skills', skillName), { recursive: true });
    includedSkills.push(skillName);
  }
}
await fs.writeFile(path.join(bootstrapRoot, 'skills', 'README.txt'), variant === 'internal'
  ? 'PixelClam 内部发布包：预置本机模型配置与 PaletX Skill。严禁上传到公开仓库或公开 Release。\n'
  : 'PixelClam 公开发布包：不含 API Key 和私有规范，默认附带“示例规范”。\n', 'utf8');
await fs.writeFile(path.join(bootstrapRoot, 'bundle-manifest.json'), JSON.stringify({
  variant,
  includesApiKey: variant === 'internal',
  includedSkills
}, null, 2), 'utf8');
console.log(`已刷新 PixelClam ${variant} 打包引导资源：${bootstrapRoot}`);
