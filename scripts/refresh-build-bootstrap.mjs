import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bootstrapRoot = path.join(appRoot, '.build-test-assets');

await fs.rm(bootstrapRoot, { recursive: true, force: true });
await fs.mkdir(path.join(bootstrapRoot, 'config'), { recursive: true });
await fs.mkdir(path.join(bootstrapRoot, 'skills'), { recursive: true });
await fs.copyFile(path.join(appRoot, 'config', 'model-config.example.json'), path.join(bootstrapRoot, 'config', 'model-config.json'));
if (process.env.UXCHECKER_BUNDLE_EXAMPLE_SKILL !== '0') {
  await fs.cp(path.join(appRoot, 'user-data', 'skills', '示例规范'), path.join(bootstrapRoot, 'skills', '示例规范'), { recursive: true });
}
await fs.writeFile(path.join(bootstrapRoot, 'skills', 'README.txt'), '应用会自动加载本目录下的每一个合格 Skill 文件夹。开源包默认附带“示例规范”；内部打包可设置 UXCHECKER_BUNDLE_EXAMPLE_SKILL=0 排除它。\n', 'utf8');
console.log(`已刷新 UXChecker-2 打包引导资源：${bootstrapRoot}`);
