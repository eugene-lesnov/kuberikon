import { open, readFile, mkdir, rename, unlink, lstat } from 'node:fs/promises';
import { join, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { emptySettings, validateSettings } from './config.js';
import { t } from './i18n/index.js';

const digest = value => value === null ? null : createHash('sha256').update(value).digest('hex');
const encode = value => JSON.stringify(value, null, 2) + '\n';
const base = (key, fallback) => process.env[key] && isAbsolute(process.env[key]) ? process.env[key] : join(homedir(), fallback);

async function readOptional(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error(t('error.settingsFile', { file }));
    return await readFile(file, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function atomicWrite(file, contents) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
    const directory = await open(dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export class SettingsStore {
  constructor() {
    this.file = join(base('XDG_CONFIG_HOME', '.config'), 'kuberikon', 'settings.json');
    this.stateFile = join(base('XDG_STATE_HOME', '.local/state'), 'kuberikon', 'state.json');
    this.lockFile = `${this.file}.lock`;
    this.data = emptySettings();
    this.state = {};
    this.queue = Promise.resolve();
    this.notices = [];
  }

  async load() {
    try {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      this.lock = await open(this.lockFile, 'wx', 0o600);
      await this.lock.writeFile(encode({ pid: process.pid, started: new Date().toISOString() }));
      await this.lock.sync();
    } catch (error) {
      this.readOnly = true;
      this.notices.push(t(error.code === 'EEXIST' ? 'error.settingsLocked' : 'error.settingsRead', { file: this.lockFile, reason: error.message }));
    }
    try {
      this.raw = await readOptional(this.file);
      if (this.raw !== null) this.data = validateSettings(JSON.parse(this.raw));
      else if (await readOptional(`${this.file}.bak`) !== null) throw new Error(t('error.settingsMissing'));
      this.hash = digest(this.raw);
    } catch (error) {
      this.damaged = true;
      this.notices.push(t('error.settingsRead', { file: this.file, reason: error.message }));
      try { this.backup = validateSettings(JSON.parse(await readOptional(`${this.file}.bak`))); } catch {}
    }
    try {
      const raw = await readOptional(this.stateFile);
      const state = raw === null ? {} : JSON.parse(raw);
      if (typeof state !== 'object' || state === null || Array.isArray(state) || (state.version !== undefined && state.version !== 1)) throw new Error(t('error.settingsSchema'));
      this.state = { version: 1, lastProfileId: typeof state.lastProfileId === 'string' ? state.lastProfileId : undefined };
    } catch (error) {
      this.stateDamaged = true;
      this.notices.push(t('error.settingsRead', { file: this.stateFile, reason: error.message }));
    }
    return this;
  }

  update(transform) {
    const operation = this.queue.then(async () => {
      if (this.closed || this.readOnly || this.damaged) throw new Error(t('error.settingsReadOnly', { file: this.file }));
      const next = validateSettings(transform(structuredClone(this.data)));
      const raw = encode(next);
      if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error(t('error.settingsSize'));
      const current = await readOptional(this.file);
      if (digest(current) !== this.hash) {
        this.readOnly = true;
        throw new Error(t('error.settingsConflict', { file: this.file }));
      }
      if (current !== null) await atomicWrite(`${this.file}.bak`, current);
      await atomicWrite(this.file, raw);
      this.data = next;
      this.raw = raw;
      this.hash = digest(raw);
      return next;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  saveState(state) {
    const operation = this.queue.then(async () => {
      if (this.closed || this.readOnly || this.stateDamaged || this.damaged) return;
      const next = { version: 1, lastProfileId: state.lastProfileId };
      await atomicWrite(this.stateFile, encode(next));
      this.state = next;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  restoreBackup() {
    const operation = this.queue.then(async () => {
      if (this.closed || !this.backup || this.readOnly || !this.damaged) throw new Error(t('error.settingsReadOnly', { file: this.file }));
      const current = await readOptional(this.file);
      if (current !== null) {
        const archive = `${this.file}.damaged-${Date.now()}-${randomUUID()}`;
        const handle = await open(archive, 'wx', 0o600);
        try { await handle.writeFile(current); await handle.sync(); } finally { await handle.close(); }
      }
      const raw = encode(this.backup);
      await atomicWrite(this.file, raw);
      this.data = this.backup;
      this.raw = raw;
      this.hash = digest(raw);
      this.damaged = false;
      this.backup = null;
      return this.data;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await this.queue;
      if (this.lock) {
        await this.lock.close();
        this.lock = null;
        await unlink(this.lockFile);
      }
    })();
    return this.closing;
  }
}
