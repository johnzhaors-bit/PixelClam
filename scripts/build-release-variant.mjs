import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const variant = String(process.argv[2] || '').trim().toLowerCase();
if (!['public', 'internal'].includes(variant)) throw new Error('用法：node scripts/build-release-variant.mjs public|internal');

const outputDir = path.join(root, 'release-artifacts', variant, `v${packageJson.version}`);
const env = { ...process.env, UXCHECKER_BUNDLE_VARIANT: variant };

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0
      ? resolve()
      : reject(new Error(`${command} ${args.join(' ')} 失败：${signal || code}`)));
  });
}

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(fullPath));
    else files.push(fullPath);
  }
  return files;
}

async function verifyBootstrap(directory) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'bundle-manifest.json'), 'utf8'));
  if (manifest.variant !== variant) throw new Error(`打包变体串包：期望 ${variant}，实际 ${manifest.variant}`);
  const config = JSON.parse(await fs.readFile(path.join(directory, 'config', 'model-config.json'), 'utf8'));
  const hasKey = Boolean(String(config.apiKey || '').trim());
  const skillNames = (await fs.readdir(path.join(directory, 'skills'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const hasPrivateSkill = skillNames.some((name) => name !== '示例规范');
  if (variant === 'public' && (hasKey || hasPrivateSkill)) throw new Error('公开包引导资源包含 API Key 或私有 Skill');
  if (variant === 'internal' && (!hasKey || !hasPrivateSkill)) throw new Error('内部包引导资源缺少 API Key 或私有 Skill');
}

await fs.rm(outputDir, { recursive: true, force: true });
await fs.mkdir(outputDir, { recursive: true });
if (variant === 'public') await run(process.execPath, ['scripts/check-release-safety.mjs']);
else await run(process.execPath, ['scripts/refresh-build-bootstrap.mjs']);
await verifyBootstrap(path.join(root, '.build-test-assets'));

const outputFlag = `--config.directories.output=${outputDir}`;
await run('npx', ['electron-builder', '--win', 'portable', '--x64', outputFlag]);
await run('npx', ['electron-builder', '--mac', 'zip', '--arm64', outputFlag]);
await run('npx', ['electron-builder', '--linux', 'AppImage', '--x64', outputFlag]);
await run(process.execPath, ['scripts/generate-release-checksums.mjs', outputDir]);

const builtFiles = await walk(outputDir);
const bundledManifests = builtFiles.filter((file) => file.endsWith(`${path.sep}test-bootstrap${path.sep}bundle-manifest.json`));
if (bundledManifests.length < 3) throw new Error(`未找到三个平台的解包引导资源，只找到 ${bundledManifests.length} 份`);
for (const manifestPath of bundledManifests) await verifyBootstrap(path.dirname(manifestPath));

await fs.writeFile(path.join(outputDir, 'RELEASE-VARIANT.json'), JSON.stringify({
  variant,
  version: packageJson.version,
  publicUploadAllowed: variant === 'public',
  includesApiKey: variant === 'internal',
  includesPrivateSkills: variant === 'internal'
}, null, 2), 'utf8');

console.log(`PixelClam ${variant} 发布包已生成：${outputDir}`);
