import { findExecutable } from './processes.js';
import { SettingsStore } from './storage.js';
import { t } from './i18n/index.js';

export async function doctor() {
  const store = new SettingsStore();
  process.stdout.write(t('doctor.runtime', { version: process.versions.node, platform: process.platform, arch: process.arch }) + '\n');
  process.stdout.write(t('settings.location', { file: store.file }) + '\n');
  process.stdout.write(t('settings.state', { file: store.stateFile }) + '\n');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (process.platform !== 'linux' || process.arch !== 'x64' || major !== 26 || minor < 4) {
    process.stdout.write(t('doctor.unsupported') + '\n');
    process.exitCode = 1;
  }
  try {
    process.stdout.write(t('doctor.kubectl', { file: findExecutable('kubectl') }) + '\n');
  } catch (error) {
    process.stdout.write(t('doctor.kubectlError', { reason: error.message }) + '\n');
    process.exitCode = 1;
  }
  process.stdout.write(t('doctor.scope') + '\n');
}
