import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { accessSync, statSync, constants } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { assertReadOnly } from './read-only.js';
import { readKubeconfig } from './kubeconfig.js';
import { t } from './i18n/index.js';

export function findExecutable(command) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const file = resolve(directory || '.', command);
    try { accessSync(file, constants.X_OK); if (statSync(file).isFile()) return file; } catch {}
  }
  throw new Error(t('error.executableMissing', { command }));
}

export class ProcessPool {
  children = new Set();
  closing = false;

  start(args, { onLine, onStdout, onStderr, onClose } = {}) {
    if (this.closing) throw new Error(t('error.shuttingDown'));
    const command = [...args];
    const profile = assertReadOnly(command);
    readKubeconfig(profile.file, profile.context);
    const child = spawn(findExecutable('kubectl'), command, { detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, KUBECTL_KUBERC: 'false' } });
    let closed = false;
    let error;
    let killTimer;
    let resolveClosed;
    const done = new Promise(resolve => { resolveClosed = resolve; });
    const handle = {
      done,
      stdout: child.stdout,
      stop: async () => {
        if (!closed && child.pid) {
          const signal = name => {
            try { process.kill(-child.pid, name); }
            catch (failure) { if (failure.code !== 'ESRCH') error = failure; }
          };
          signal('SIGTERM');
          killTimer ??= setTimeout(() => signal('SIGKILL'), 1500);
          killTimer.unref();
        }
        await done;
      },
    };
    this.children.add(handle);
    const readers = [];
    for (const [stream, isError, onChunk] of [[child.stdout, false, onStdout], [child.stderr, true, onStderr]]) {
      if (!onLine && !onChunk) continue;
      const decoder = new StringDecoder('utf8');
      let carry = '';
      let discarding = false;
      const feed = text => {
        if (!onLine) return;
        if (discarding) {
          const end = text.indexOf('\n');
          if (end === -1) return;
          text = text.slice(end + 1);
          discarding = false;
        }
        carry += text;
        let newline;
        while ((newline = carry.indexOf('\n')) !== -1) {
          const line = carry.slice(0, newline).replace(/\r$/, '');
          onLine(line.length > 65536 ? line.slice(0, 65536) + ` … [${t('error.truncatedRecord')}]` : line, isError);
          carry = carry.slice(newline + 1);
        }
        if (carry.length > 65536) {
          onLine(carry.slice(0, 65536) + ` … [${t('error.truncatedRecord')}]`, isError);
          carry = '';
          discarding = true;
        }
      };
      stream.on('data', chunk => { onChunk?.(chunk); feed(decoder.write(chunk)); });
      readers.push(() => { feed(decoder.end()); if (carry) onLine?.(carry, isError); });
    }
    child.once('error', failure => { error = failure; });
    child.once('close', (code, signal) => {
      closed = true;
      clearTimeout(killTimer);
      for (const finish of readers) finish();
      this.children.delete(handle);
      const result = { code, signal, error };
      resolveClosed(result);
      onClose?.(result);
    });
    return handle;
  }

  async run(args, { signal, timeout = 25000 } = {}) {
    if (signal?.aborted) throw new DOMException(t('error.requestCancelled'), 'AbortError');
    const output = [];
    const errors = [];
    let bytes = 0;
    let errorBytes = 0;
    let failure;
    const handle = this.start(args, {
      onStdout: chunk => {
        bytes += chunk.length;
        if (bytes > 24 * 1024 * 1024) {
          failure ??= new Error(t('error.largeResponse'));
          void handle.stop();
        } else output.push(chunk);
      },
      onStderr: chunk => { const part = chunk.subarray(0, Math.max(0, 65536 - errorBytes)); errorBytes += part.length; if (part.length) errors.push(part); },
    });
    const abort = () => { failure = new DOMException(t('error.requestCancelled'), 'AbortError'); void handle.stop(); };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { failure ??= Object.assign(new Error(t('error.requestTimeout', { seconds: timeout / 1000 })), { code: 'ETIMEDOUT' }); void handle.stop(); }, timeout);
    try {
      if (signal?.aborted) abort();
      const result = await handle.done;
      if (failure) throw failure;
      if (result.error) throw new Error(result.error.code === 'ENOENT' ? t('error.kubectlMissing') : result.error.message);
      if (result.code !== 0) throw new Error(Buffer.concat(errors).toString('utf8').trim() || t('error.kubectlExit', { code: result.code }));
      return Buffer.concat(output).toString('utf8');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async close() {
    this.closing = true;
    this.closed ??= Promise.allSettled([...this.children].map(handle => handle.stop()));
    await this.closed;
  }
}
