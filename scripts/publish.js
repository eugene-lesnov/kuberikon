import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import pkg from '../package.json' with { type: 'json' };

const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' } } });
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
if (!stableVersion.test(pkg.version)) throw new Error('npm releases must use a stable major.minor.patch version');
if (pkg.private) throw new Error('The npm package must not be private');

const registry = 'https://registry.npmjs.org/';
const archive = resolve('dist', `${pkg.name}-${pkg.version}.tgz`);
const integrity = `sha512-${createHash('sha512').update(await readFile(archive)).digest('base64')}`;

if (values['dry-run']) {
  publish('latest', true);
} else {
  const response = await fetch(new URL(encodeURIComponent(pkg.name), registry), {
    headers: { accept: 'application/vnd.npm.install-v1+json' }, signal: AbortSignal.timeout(20000),
  });
  if (response.status === 404) {
    if (pkg.version !== '0.1.0') throw new Error('The npm package does not exist. Publish 0.1.0 manually before automated releases');
    const message = `First npm publication required: download the GitHub Release archive and run npm login, then npm publish ./kuberikon-0.1.0.tgz --access public --tag latest --ignore-scripts`;
    process.stdout.write(`${message}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## First npm publication\n\n${message}.\n\nConfigure the Trusted Publisher when the next release is ready.\n`);
    await output(true);
  } else {
    if (!response.ok) throw new Error(`npm registry lookup failed: HTTP ${response.status}`);
    const metadata = await response.json();
    if (metadata.name !== pkg.name) throw new Error('The npm registry returned an unexpected package');
    const latest = metadata['dist-tags']?.latest;
    if (!stableVersion.test(latest ?? '')) throw new Error('The npm package must have a stable latest tag');
    const isLatest = compareVersions(pkg.version, latest) >= 0;
    const existing = metadata.versions?.[pkg.version];
    if (existing) {
      if (existing.dist?.integrity !== integrity) throw new Error(`${pkg.name}@${pkg.version} is already published with a different archive; use a new version`);
      if (isLatest && pkg.version !== latest) throw new Error(`${pkg.name}@${pkg.version} exists, but npm latest points to ${latest}; correct the npm tag before rerunning`);
      process.stdout.write(`${pkg.name}@${pkg.version} is already published with the same archive\n`);
    } else {
      publish(isLatest ? 'latest' : 'previous');
    }
    await output(isLatest);
  }
}

function compareVersions(left, right) {
  const first = left.split('.').map(part => BigInt(part));
  const second = right.split('.').map(part => BigInt(part));
  for (let index = 0; index < first.length; index++) {
    if (first[index] !== second[index]) return first[index] > second[index] ? 1 : -1;
  }
  return 0;
}

function publish(tag, dryRun = false) {
  const args = ['publish', archive, '--registry', registry, '--access', 'public', '--tag', tag, '--ignore-scripts'];
  if (dryRun) args.push('--dry-run');
  const result = process.env.npm_execpath
    ? spawnSync(process.execPath, [process.env.npm_execpath, ...args], { stdio: 'inherit' })
    : spawnSync('npm', args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm publish exited with code ${result.status}`);
}

async function output(latest) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `latest=${latest}\n`);
}
