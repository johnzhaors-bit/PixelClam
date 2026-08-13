#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [
  path.join(appRoot, 'node_modules', 'electron', 'dist', 'Electron.app'),
  '/Users/a10146331/JINJIA/node_modules/.pnpm/electron@33.4.11/node_modules/electron/dist/Electron.app',
  '/Users/a10146331/Documents/JINJIA/upstream/opencode/node_modules/.bun/electron@42.3.3+759ce506b1ed1a42/node_modules/electron/dist/Electron.app'
];

function executableFor(appPath) {
  return path.join(appPath, 'Contents', 'MacOS', 'Electron');
}

function isCompleteRuntime(appPath) {
  return fs.existsSync(executableFor(appPath)) &&
    fs.existsSync(path.join(appPath, 'Contents', 'Frameworks', 'Electron Framework.framework')) &&
    fs.existsSync(path.join(appPath, 'Contents', 'Resources', 'default_app.asar'));
}

const runtime = candidates.find(isCompleteRuntime);
if (!runtime) {
  throw new Error('没有找到完整的 Electron 开发运行时。请执行 npm install，并确认 Electron 下载完成。');
}

const child = spawn(executableFor(runtime), [appRoot], {
  cwd: appRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    UXCHECKER_HOME: process.env.UXCHECKER_HOME || path.join(appRoot, 'user-data')
  }
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
