import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, copyFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import pkg from '../package.json' with { type: 'json' };

const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
if (lock.version !== pkg.version || lock.packages[''].version !== pkg.version) {
  throw new Error('package.json and package-lock.json versions must match');
}

await mkdir('dist', { recursive: true });
const staging = await mkdtemp(resolve('dist/npm-'));
try {
  const packageRoot = join(staging, 'package');
  for (const file of [...pkg.files, 'README.md', 'LICENSE']) {
    const target = join(packageRoot, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(file, target);
  }
  const manifest = { ...pkg };
  delete manifest.scripts;
  delete manifest.devDependencies;
  delete manifest.files;
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const args = ['pack', packageRoot, '--ignore-scripts', '--pack-destination', staging];
  const options = { stdio: 'inherit' };
  const result = process.env.npm_execpath
    ? spawnSync(process.execPath, [process.env.npm_execpath, ...args], options)
    : spawnSync('npm', args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm pack exited with code ${result.status}`);
  const archive = `${pkg.name}-${pkg.version}.tgz`;
  await rename(join(staging, archive), join('dist', archive));
  const digest = createHash('sha256').update(await readFile(join('dist', archive))).digest('hex');
  await writeFile('dist/SHA256SUMS', `${digest}  ${archive}\n`);
  process.stdout.write(`Package: dist/${archive}\nPacked: ${(await stat(join('dist', archive))).size} bytes\n`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
