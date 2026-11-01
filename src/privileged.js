import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { findExecutable } from './processes.js';
import { validateForward } from './config.js';
import { privilegedPortThreshold, assertLocalPort } from './ports.js';
import { t } from './i18n/index.js';

export async function authorizeSudo(signal, requestPassword) {
  if (signal.aborted) throw new DOMException(t('error.requestCancelled'), 'AbortError');
  const child = spawn(findExecutable('sudo'), ['-S', '-v', '-p', '\x1ekuberikon-sudo:%p\x1f'], { stdio: ['pipe', 'ignore', 'pipe'] });
  const prompts = new AbortController();
  const promptSignal = AbortSignal.any([signal, prompts.signal]);
  let failure;
  let killTimer;
  let closed = false;
  let output = '';
  let prompted = false;
  let pending = Promise.resolve();
  const fail = error => {
    if (closed) return;
    failure ??= error;
    prompts.abort();
    child.stdin.destroy();
    child.kill('SIGTERM');
    killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1500);
    killTimer.unref();
  };
  const abort = () => fail(new DOMException(t('error.requestCancelled'), 'AbortError'));
  child.stdin.on('error', fail);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    output = (output + chunk).slice(-8192);
    let match;
    while ((match = /\x1ekuberikon-sudo:([^\x1f]*)\x1f/.exec(output))) {
      const user = match[1];
      const message = output.slice(0, match.index).trim();
      output = output.slice(match.index + match[0].length);
      const retry = prompted;
      prompted = true;
      pending = pending.then(async () => {
        if (promptSignal.aborted) return;
        const password = await requestPassword({ user, retry, message, signal: promptSignal });
        try {
          if (promptSignal.aborted || closed) return;
          await new Promise((resolveWritten, rejectWrite) => {
            child.stdin.write(password);
            child.stdin.write('\n', error => { if (error) rejectWrite(error); else resolveWritten(); });
          });
        } finally { password.fill(0); }
      }).catch(fail);
    }
  });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    await new Promise((resolveDone, reject) => {
      child.once('error', fail);
      child.once('close', code => {
        closed = true;
        prompts.abort();
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(output.trim() || t('error.sudoDenied')));
        else resolveDone();
      });
    });
  } finally {
    clearTimeout(killTimer);
    signal.removeEventListener('abort', abort);
    prompts.abort();
    await pending;
  }
}

export class PrivilegedPorts {
  authorization = Promise.resolve();
  handles = new Set();
  closing = false;

  constructor(authorize) { this.authorize = authorize; }

  async prepare(spec, signal) {
    validateForward(spec);
    if (signal.aborted || this.closing) throw new DOMException(t('error.requestCancelled'), 'AbortError');
    const threshold = await privilegedPortThreshold();
    await assertLocalPort(spec, signal, threshold);
    const privileged = spec.localPort < threshold;
    if (privileged) {
      const operation = this.authorization.catch(() => {}).then(async () => {
        if (signal.aborted || this.closing) throw new DOMException(t('error.requestCancelled'), 'AbortError');
        await this.authorize(spec.localPort, signal);
      });
      this.authorization = operation;
      await operation;
    }
    return { privileged };
  }

  forward(spec, start, callbacks) {
    if (this.closing) throw new Error(t('error.shuttingDown'));
    let upstream;
    let proxy;
    let proxyPid;
    let proxyClosed;
    let startupTimer;
    let killTimer;
    let ending;
    let startingProxy = false;
    let resolveDone;
    const done = new Promise(resolveClosed => { resolveDone = resolveClosed; });
    const finish = result => {
      if (ending) return ending;
      ending = Promise.resolve().then(async () => {
        clearTimeout(startupTimer);
        if (proxy) {
          proxy.stdin?.end();
          if (proxyPid) { try { process.kill(proxyPid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') result.error ??= error; } }
          else proxy.kill('SIGTERM');
          killTimer = setTimeout(() => { try { if (proxyPid) process.kill(proxyPid, 'SIGKILL'); else proxy.kill('SIGKILL'); } catch {} }, 1500);
          killTimer.unref();
        }
        await upstream?.stop();
        await proxyClosed;
        clearTimeout(killTimer);
        this.handles.delete(handle);
        resolveDone(result);
        callbacks.onClose?.(result);
      });
      return ending;
    };
    const handle = { done, stop: () => finish({ code: 0, signal: 'SIGTERM' }) };
    this.handles.add(handle);
    const launchProxy = async port => {
      try {
        const stat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
        if (ending) return;
        const started = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
        proxy = spawn(findExecutable('sudo'), ['-n', '--', process.execPath, '--experimental-ffi', '--disable-warning=ExperimentalWarning',
          resolve(process.argv[1]), '--port-helper',
          `--address=${spec.address}`, `--port=${spec.localPort}`, `--target-port=${port}`, `--parent=${process.pid}`, `--parent-start=${started}`],
        { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, TERM: process.env.TERM, LANG: process.env.LANG } });
        let diagnostic = '';
        let output = '';
        proxy.stdin.on('error', () => {});
        proxy.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-8192); });
        proxy.stdout.on('data', chunk => {
          output += chunk.toString('utf8');
          if (output.length > 256) { void finish({ error: new Error(t('error.portHelper')) }); return; }
          const match = /^READY (\d+)\r?\n$/.exec(output);
          if (!match || proxyPid) return;
          const pid = Number(match[1]);
          if (!Number.isSafeInteger(pid) || pid <= 1) { void finish({ error: new Error(t('error.portHelper')) }); return; }
          proxyPid = pid;
          clearTimeout(startupTimer);
          if (ending) {
            try { process.kill(proxyPid, 'SIGTERM'); } catch {}
            clearTimeout(killTimer);
            killTimer = setTimeout(() => { try { process.kill(proxyPid, 'SIGKILL'); } catch {} }, 1500);
            killTimer.unref();
            return;
          }
          callbacks.onLine?.(`Forwarding from ${spec.address}:${spec.localPort} -> ${spec.remotePort}`);
        });
        proxy.once('error', error => { void finish({ error }); });
        proxyClosed = new Promise(resolveClosed => {
          proxy.once('close', code => {
            resolveClosed();
            if (!ending) void finish({ code, error: new Error(diagnostic.trim() || t('error.portHelper')) });
          });
        });
        startupTimer = setTimeout(() => { void finish({ error: new Error(t('error.portHelper')) }); }, 10000);
      } catch (error) { void finish({ error }); }
    };
    try {
      upstream = start(0, '127.0.0.1', {
        onLine: (line, error) => {
          if (ending) return;
          const match = !error && /^Forwarding from 127\.0\.0\.1:(\d+) ->/.exec(line);
          if (match) {
            const port = Number(match[1]);
            if (!startingProxy && port >= 1 && port <= 65535) { startingProxy = true; void launchProxy(port); }
          } else callbacks.onLine?.(line, error);
        },
        onClose: result => { void finish(result); },
      });
    } catch (error) { this.handles.delete(handle); throw error; }
    return handle;
  }

  async close() {
    this.closing = true;
    await Promise.allSettled([...this.handles].map(handle => handle.stop()));
  }
}
