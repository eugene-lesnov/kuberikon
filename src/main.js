import { parseArgs } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { t } from './i18n/index.js';

const help = t('cli.help', { version: pkg.version });

async function main() {
  if (process.argv[2] === '--port-helper') {
    const { runPortHelper } = await import('./port-helper.js');
    await runPortHelper();
    return;
  }
  let values;
  try {
    ({ values } = parseArgs({ options: {
      kubeconfig: { type: 'string' }, 'profiles-dir': { type: 'string' },
      namespace: { type: 'string' }, theme: { type: 'string', default: 'dark' },
      'no-autostart': { type: 'boolean' }, doctor: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    } }));
  } catch (error) {
    process.stderr.write(`${error.message}\n${t('cli.helpHint')}\n`);
    process.exitCode = 2;
    return;
  }
  if (values.help) { process.stdout.write(help); return; }
  if (values.version) { process.stdout.write(`kuberikon ${pkg.version}\n`); return; }
  if (values.doctor) { const { doctor } = await import('./doctor.js'); await doctor(); return; }
  if (!['dark', 'light'].includes(values.theme)) throw new Error(t('error.theme'));
  if (process.getuid?.() === 0 || process.geteuid?.() === 0) throw new Error(t('error.rootSession'));
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(t('error.terminal'));
  const { startApp } = await import('./ui.js');
  await startApp(values, pkg.version);
}

main().catch(error => {
  process.stderr.write(`kuberikon: ${error.message}\n`);
  process.exitCode = 1;
});
