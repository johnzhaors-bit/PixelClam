import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bootstrapRoot = path.join(root, '.build-test-assets');

function fail(message) {
  throw new Error(`发布安全检查失败：${message}`);
}

async function walk(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(fullPath));
    else result.push(fullPath);
  }
  return result;
}

const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
if (packageJson.name !== 'pixelclam') fail('package.json.name 必须为 pixelclam');
if (packageJson.build?.productName !== 'PixelClam') fail('build.productName 必须为 PixelClam');
if (packageJson.build?.appId !== 'com.pixelclam.desktop') fail('build.appId 必须为 com.pixelclam.desktop');

const publicConfig = JSON.parse(await fs.readFile(path.join(root, 'config/model-config.example.json'), 'utf8'));
if (String(publicConfig.apiKey || '').trim()) fail('公开模型配置的 apiKey 必须为空');

const serializedBuild = JSON.stringify(packageJson.build || {});
for (const forbidden of ['user-data/**/*', 'docs/**/*', 'tests/**/*']) {
  if (!serializedBuild.includes(`!${forbidden}`)) fail(`Electron files 白名单缺少 !${forbidden}`);
}

await execFileAsync(process.execPath, [path.join(root, 'scripts/refresh-build-bootstrap.mjs')], {
  cwd: root,
  env: { ...process.env, UXCHECKER_BUNDLE_VARIANT: 'public', UXCHECKER_BUNDLE_EXAMPLE_SKILL: '1' }
});

const bootstrapFiles = await walk(bootstrapRoot);
const bootstrapRelative = bootstrapFiles.map((file) => path.relative(bootstrapRoot, file));
if (!bootstrapRelative.some((file) => file.includes(`skills${path.sep}示例规范${path.sep}`))) fail('开源引导资源缺少示例 Skill');
if (bootstrapRelative.some((file) => /Paletx|disabled-skills|runs|reports/i.test(file))) fail('引导资源包含私有 Skill 或运行证据');

const textExtensions = new Set(['.json', '.md', '.txt', '.js', '.mjs', '.cjs', '.html', '.css']);
const secretPatterns = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\b[A-Za-z][A-Za-z0-9]{3,15}_[A-Za-z0-9_]{24,}\b/,
  /wxai-nic\.zx\.zte\.com\.cn/i,
  /"apiKey"\s*:\s*"[^"\s]+"/
];
for (const file of bootstrapFiles) {
  if (!textExtensions.has(path.extname(file))) continue;
  const content = await fs.readFile(file, 'utf8');
  if (secretPatterns.some((pattern) => pattern.test(content))) fail(`引导资源疑似包含凭据或内网地址：${path.relative(root, file)}`);
}

const { stdout } = await execFileAsync('git', ['ls-files'], { cwd: root });
const tracked = stdout.trim().split('\n').filter(Boolean);
const forbiddenTracked = tracked.filter((file) => /(^|\/)(Paletx-MultiSkin-Audit|\.disabled-skills|runs|reports|dist|交付文件)(\/|$)/i.test(file));
if (forbiddenTracked.length) fail(`Git 中存在禁止发布路径：${forbiddenTracked.slice(0, 5).join(', ')}`);

console.log(JSON.stringify({
  ok: true,
  productName: packageJson.build.productName,
  version: packageJson.version,
  bootstrapFileCount: bootstrapFiles.length,
  trackedFileCount: tracked.length,
  bundledSkill: '示例规范',
  apiKeyEmpty: true
}, null, 2));
