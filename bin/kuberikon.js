#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== 26 || minor < 4) {
  process.stderr.write(`kuberikon: Node.js >=26.4.0 <27 is required; found ${process.versions.node}.\n`);
  process.exit(1);
}
if (process.platform !== 'linux' || process.arch !== 'x64' || !process.report.getReport().header.glibcVersionRuntime) {
  process.stderr.write('kuberikon: Linux x64 with glibc is required.\n');
  process.exit(1);
}

try {
  process.execve(process.execPath, [process.execPath, '--experimental-ffi', '--disable-warning=ExperimentalWarning',
    fileURLToPath(new URL('../dist/kuberikon.mjs', import.meta.url)), ...process.argv.slice(2)], {
    ...process.env,
    OTUI_ASSET_ROOT: fileURLToPath(new URL('../dist/assets/', import.meta.url)),
    OPENTUI_LIBC: 'glibc',
  });
} catch (error) {
  process.stderr.write(`kuberikon: ${error.message}\n`);
  process.exitCode = 1;
}
