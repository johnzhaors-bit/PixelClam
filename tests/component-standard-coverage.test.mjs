import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../user-data/skills/示例规范');

test('公开示例 Skill 的每个组件规范均可独立发送', async () => {
  const skinIndex = JSON.parse(await fs.readFile(path.join(root, 'standards/skins/index.json'), 'utf8'));
  assert.ok(skinIndex.skins.length >= 1);
  for (const skin of skinIndex.skins) {
    const componentDir = path.join(root, 'standards/component-packs-v3/skins', skin.id, 'components');
    const files = (await fs.readdir(componentDir)).filter((name) => name.endsWith('.json'));
    assert.ok(files.length >= 1, skin.id);
    for (const file of files) {
      const pack = JSON.parse(await fs.readFile(path.join(componentDir, file), 'utf8'));
      assert.equal(pack.selfContained, true, file);
      assert.equal(pack.skin.id, skin.id, file);
      assert.equal(pack.component.id, path.basename(file, '.json'), file);
      assert.ok(pack.rules || pack.componentStructure || pack.skinStyle || pack.sourceResolvedStyle, file);
    }
  }
});
