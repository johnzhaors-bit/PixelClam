import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

test('公开配置模板不包含 API Key', async () => {
  const config = JSON.parse(await fs.readFile(path.join(root, 'config/model-config.example.json'), 'utf8'));
  assert.equal(config.apiKey, '');
  assert.equal(config.provider, 'openai-compatible');
  assert.match(config.baseUrl, /^https:\/\//);
});

test('打包引导只包含空配置和 Skill 安装说明', async () => {
  const script = await fs.readFile(path.join(root, 'scripts/refresh-build-bootstrap.mjs'), 'utf8');
  assert.doesNotMatch(script, /model-config\.external-kimi|Paletx-MultiSkin-Audit/);
  assert.match(script, /model-config\.example\.json/);
  assert.match(script, /示例规范/);
});

test('公开示例 Skill 可被应用自动注册并包含独立组件规范', async () => {
  const skillRoot = path.join(root, 'user-data/skills/示例规范');
  const manifest = JSON.parse(await fs.readFile(path.join(skillRoot, 'skill.json'), 'utf8'));
  const skins = JSON.parse(await fs.readFile(path.join(skillRoot, 'standards/skins/index.json'), 'utf8'));
  assert.equal(manifest.id, 'generic-web-audit');
  assert.deepEqual(manifest.visibleSkins, ['default']);
  assert.equal(skins.skins[0].id, 'default');
  const componentDir = path.join(skillRoot, 'standards/component-packs-v3/skins/default/components');
  const files = (await fs.readdir(componentDir)).filter((name) => name.endsWith('.json'));
  assert.deepEqual(files.sort(), ['button.json', 'input.json', 'pagination.json', 'select.json', 'table.json']);
  for (const file of files) {
    const standard = JSON.parse(await fs.readFile(path.join(componentDir, file), 'utf8'));
    assert.equal(standard.selfContained, true);
  }
  await fs.access(path.join(skillRoot, 'standards/layout/layout-audit-pack-v1.json'));
  await fs.access(path.join(skillRoot, manifest.reportRenderer));
});
