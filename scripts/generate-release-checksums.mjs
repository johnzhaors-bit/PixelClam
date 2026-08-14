import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.resolve(process.argv[2] || process.env.UXCHECKER_RELEASE_DIR || path.join(root, 'dist'));
const supported = /\.(?:exe|zip|AppImage|deb|tar\.gz)$/i;
const files = (await fs.readdir(dist)).filter((name) => supported.test(name)).sort();
if (!files.length) throw new Error('dist 中没有可发布安装包');

const lines = [];
for (const name of files) {
  const buffer = await fs.readFile(path.join(dist, name));
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  lines.push(`${digest}  ${name}`);
}
await fs.writeFile(path.join(dist, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'utf8');
console.log(lines.join('\n'));
