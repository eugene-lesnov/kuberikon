import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

async function sources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? sources(join(directory, entry.name)) : entry.name.endsWith('.js') ? [join(directory, entry.name)] : []));
  return nested.flat();
}

const files = [...await sources('src'), ...await sources('scripts'), ...await sources('bin')];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
process.stdout.write(`JavaScript syntax checked: ${files.length} files\n`);
