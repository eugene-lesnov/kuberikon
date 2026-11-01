import { build } from 'esbuild';
import { getNodeAssets } from '@opentui/core/node-assets';
import { mkdir, readFile, writeFile, copyFile, readdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== 26 || minor < 4) throw new Error('Build requires Node.js 26.4 or newer in the 26.x release line');
const pinnedNode = (await readFile('.node-version', 'utf8')).trim();
if (process.versions.node !== pinnedNode) throw new Error(`Build requires the pinned Node.js version ${pinnedNode}`);
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This build targets Linux x64 (glibc)');
await mkdir('dist', { recursive: true });
const assets = getNodeAssets({ platform: 'linux', arch: 'x64', libc: 'glibc' })
  .filter(({ key }) => key === '@opentui/core-linux-x64/libopentui.so');
if (assets.length !== 1) throw new Error('Expected the Linux x64 OpenTUI native library');
const bundled = await build({
  entryPoints: ['src/main.js'], bundle: true, platform: 'node', target: 'node26', format: 'esm',
  outfile: 'dist/kuberikon.mjs', write: false, external: ['bun', 'bun:*'],
  minify: true, keepNames: true, legalComments: 'inline',
  banner: { js: 'import { createRequire as __kuberikonCreateRequire } from "node:module"; const require = __kuberikonCreateRequire(import.meta.url);' },
});
await writeFile('dist/kuberikon.mjs', bundled.outputFiles[0].text);
for (const { key, source } of assets) {
  const target = resolve('dist/assets', key);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

const notices = [];
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
for (const folder of Object.keys(lock.packages)) {
  if (!folder.startsWith('node_modules/')) continue;
  let entries;
  try { entries = await readdir(folder, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    if (entry.isFile() && /^(license|licence|copying|notice|copyright)([-.]|$)/i.test(entry.name)) {
      notices.push(`===== ${folder}/${entry.name} =====\n${await readFile(join(folder, entry.name), 'utf8')}`);
    }
  }
}
await writeFile('dist/THIRD_PARTY_NOTICES.txt', notices.join('\n\n'));
process.stdout.write('Built dist/kuberikon.mjs and OpenTUI runtime assets\n');
