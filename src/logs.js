import { open, link, unlink, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { limitRecord } from './text.js';
import { t } from './i18n/index.js';

export const initialLogLines = 500;

export class LogBuffer {
  records = [];
  sequence = 0;
  displayed = 0;

  clear() { this.records = []; this.displayed = 0; }

  add(text, error, source) {
    const value = limitRecord(text);
    const timestamp = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})\s/.exec(value);
    const time = timestamp ? Date.parse(timestamp[0].trim()) : NaN;
    const record = { text: value, error, source, sequence: ++this.sequence,
      time: Number.isFinite(time) ? time : Date.now(), fraction: timestamp?.[2]?.padEnd(9, '0') ?? '000000000' };
    this.records.push(record);
  }

  merge(history) {
    const existing = new Map();
    for (const record of this.records) {
      if (record.error) continue;
      let counts = existing.get(record.source);
      if (!counts) existing.set(record.source, counts = new Map());
      counts.set(record.text, (counts.get(record.text) ?? 0) + 1);
    }
    const added = [];
    for (const record of history.records) {
      const counts = existing.get(record.source);
      const remaining = counts?.get(record.text) ?? 0;
      if (remaining) counts.set(record.text, remaining - 1);
      else {
        record.sequence = 0;
        added.push(record);
      }
    }
    if (added.length) {
      this.records = this.records.concat(added).sort((left, right) => left.time - right.time || left.fraction.localeCompare(right.fraction));
      this.displayed = 0;
    }
    return added;
  }

  matching(query = '') {
    const lower = query.toLowerCase();
    for (let index = this.displayed; index < this.records.length; index++) {
      const record = this.records[index];
      record.caption = record.source.caption;
      record.display = (record.caption ? `[${record.caption}] ` : '') + record.text;
    }
    this.displayed = this.records.length;
    return lower ? this.records.filter(record => [record.display, record.source.label].some(text => text.toLowerCase().includes(lower))) : this.records;
  }
}

async function* streamLines(stream) {
  const decoder = new StringDecoder('utf8');
  let carry = '';
  let discarding = false;
  for await (const chunk of stream) {
    let text = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (discarding) {
      const end = text.indexOf('\n');
      if (end === -1) continue;
      text = text.slice(end + 1);
      discarding = false;
    }
    carry += text;
    let newline;
    while ((newline = carry.indexOf('\n')) !== -1) {
      const line = carry.slice(0, newline).replace(/\r$/, '');
      carry = carry.slice(newline + 1);
      yield limitRecord(line);
    }
    if (carry.length > 65536) {
      yield limitRecord(carry);
      carry = '';
      discarding = true;
    }
  }
  if (!discarding) {
    carry += decoder.end();
    if (carry) yield limitRecord(carry);
  }
}

export class LogExport {
  handles = new Set();
  cancelled = false;

  constructor({ backend, profile, sources, file, records }) {
    Object.assign(this, { backend, profile, sources, file, records });
  }

  async run() {
    const temporary = join(dirname(this.file), `.kuberikon-export-${randomUUID()}.partial`);
    let stream;
    let streamFailure;
    let lines = 0;
    try {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const reservation = await open(temporary, 'wx', 0o600);
      await reservation.close();
      stream = createWriteStream(temporary, { flags: 'r+', mode: 0o600 });
      const completion = finished(stream);
      completion.catch(() => {});
      stream.on('error', error => { streamFailure = error; for (const handle of this.handles) void handle.stop(); });
      const write = async text => {
        if (streamFailure) throw streamFailure;
        if (this.cancelled) throw new Error(t('error.exportCancelled'));
        lines++;
        if (!stream.write(text + '\n')) await once(stream, 'drain');
      };
      if (this.records) {
        for (const record of this.records) await write(record.display);
      } else {
        for (const source of this.sources) {
          if (this.cancelled) break;
          const diagnostic = [];
          let diagnosticBytes = 0;
          const handle = this.backend.logHistory(this.profile, source.pod, source.container, {
            onStderr: chunk => {
              const part = chunk.subarray(0, Math.max(0, 65536 - diagnosticBytes));
              diagnosticBytes += part.length;
              if (part.length) diagnostic.push(part);
            },
          });
          this.handles.add(handle);
          this.timer = setTimeout(() => { this.cancelled = true; void handle.stop(); }, 5 * 60 * 1000);
          for await (const text of streamLines(handle.stdout)) {
            await write((this.sources.length > 1 ? `[${source.pod.name}/${source.container}] ` : '') + text);
          }
          const result = await handle.done;
          clearTimeout(this.timer);
          this.handles.delete(handle);
          if (result.error || result.code) throw new Error(result.error?.message || Buffer.concat(diagnostic).toString('utf8').trim() || t('error.kubectlExit', { code: result.code }));
        }
      }
      if (streamFailure) throw streamFailure;
      if (this.cancelled) throw new Error(t('error.exportCancelled'));
      stream.end();
      await completion;
      const handle = await open(temporary, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
      if (this.cancelled) throw new Error(t('error.exportCancelled'));
      await link(temporary, this.file);
      return lines;
    } catch (error) {
      if (streamFailure) throw streamFailure;
      if (this.cancelled) throw new Error(t('error.exportCancelled'));
      throw error;
    } finally {
      clearTimeout(this.timer);
      for (const handle of this.handles) await handle.stop();
      stream?.destroy();
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async cancel() {
    this.cancelled = true;
    clearTimeout(this.timer);
    await Promise.allSettled([...this.handles].map(handle => handle.stop()));
  }
}
