import { limitRecord } from './text.js';
import { LogBuffer } from './logs.js';
import { t } from './i18n/index.js';

const permanentLogError = /forbidden|unauthorized|permission denied|\b(?:ENOENT|ENOTDIR|EISDIR|EACCES)\b|unknown flag|unknown command|invalid configuration|error loading config|kubeconfig|\.kuber|current-context|selected context|static credentials|not found in PATH|no context exists|context .*does not exist|certificate (?:has expired|signed by unknown|is not)|x509:|container .* (?:not found|not valid)|container .* is not valid/i;
const missingPod = /\bNotFound\b|\bpods?\b[^\n]*\bnot found\b/i;

export class LogStreams {
  constructor(app) {
    this.app = app;
    this.logClosures = new Set();
  }

  async changeLogSources(candidates, { automatic = false, restart = false } = {}) {
    const app = this.app;
    const logs = app.logs;
    if (!logs || app.closing || !candidates.length || candidates.length > 16) return;
    if (!automatic) this.beginLogAction(logs);
    const revision = logs.sourceRevision = (logs.sourceRevision ?? 0) + 1;
    const previous = logs.sources;
    const sources = candidates.map(candidate => previous.find(source => this.logSourceKey(source) === this.logSourceKey(candidate)) ?? {
      pod: candidate.pod, container: candidate.container, serviceTarget: candidate.serviceTarget,
      label: `${candidate.pod.namespace}/${candidate.pod.name}/${candidate.container}`, status: 'opening',
    });
    logs.sources = sources;
    const history = new Set([...logs.buffer.records.map(record => record.source), ...sources]);
    const combined = new Set([...history].map(source => this.logSourceKey(source))).size > 1;
    for (const source of history) {
      source.caption = combined ? `${source.pod.name}/${source.container}` : '';
    }
    const stopped = previous.filter(source => !sources.includes(source) || restart);
    const closing = Promise.allSettled(stopped.map(source => this.stopLogSource(source)));
    this.logClosures.add(closing);
    await closing;
    this.logClosures.delete(closing);
    if (app.logs !== logs || app.closing || logs.sourceRevision !== revision) return;
    if (restart) {
      logs.buffer.clear();
      app.resetLogHistory();
      for (const source of sources) { source.lastTimestamp = null; source.retries = 0; }
    }
    for (const source of sources) {
      if (logs.sources.includes(source) && (!previous.includes(source) || restart) && !source.handle) this.openLogStream(logs, source);
    }
    logs.dirty = true;
    const failure = sources.find(source => source.status === 'error')?.message;
    this.logMessage(logs, failure || t('logs.open'), Boolean(failure));
    app.updateHeader();
    app.flushLogs(true);
  }

  async reloadLogs() {
    const app = this.app;
    const logs = app.logs;
    if (!logs || logs.reconnecting) return;
    logs.reconnecting = true;
    const controller = this.beginLogAction(logs);
    const sources = [...logs.sources];
    const revision = logs.sourceRevision;
    const checkpoint = logs.buffer.sequence;
    const history = new LogBuffer();
    history.sequence = checkpoint;
    this.logMessage(logs, t('logs.reloadingHistory'));
    const reading = Promise.allSettled(sources.map(source => this.readLogHistory(logs, source, controller.signal, history)));
    this.logClosures.add(reading);
    try {
      const results = await reading;
      if (app.logs !== logs || app.closing || logs.sourceRevision !== revision) return;
      if (controller.signal.aborted) { this.logMessage(logs, t('logs.historyReloadCancelled')); return; }
      const failure = results.find(result => result.status === 'rejected');
      if (failure) { this.logMessage(logs, t('logs.historyReloadFailed', { reason: failure.reason.message }), true); return; }
      const replay = new Map(sources.map(source => [source, new Map()]));
      for (const record of history.records) {
        const counts = replay.get(record.source);
        counts.set(record.text, (counts.get(record.text) ?? 0) + 1);
      }
      const loaded = new Map([...replay].map(([source, counts]) => [source, new Map(counts)]));
      for (const record of logs.buffer.records) {
        const counts = replay.get(record.source);
        const remaining = counts?.get(record.text) ?? 0;
        if (!record.error && remaining) counts.set(record.text, remaining - 1);
      }
      for (const source of sources) {
        const pending = new Map();
        for (const [text, count] of loaded.get(source)) {
          const remaining = (replay.get(source).get(text) ?? 0) + (source.historyReplay?.get(text) ?? 0);
          if (remaining) pending.set(text, Math.min(count, remaining));
        }
        source.historyReplay = pending.size ? pending : null;
      }
      history.sequence = Math.max(history.sequence, logs.buffer.sequence);
      for (const record of logs.buffer.records) {
        if (record.sequence <= checkpoint) continue;
        const counts = loaded.get(record.source);
        const remaining = counts?.get(record.text) ?? 0;
        if (!record.error && remaining) counts.set(record.text, remaining - 1);
        else history.add(record.text, record.error, record.source);
      }
      logs.buffer = history;
      app.resetLogHistory();
      logs.pausedAt = history.sequence;
      logs.dirty = true;
      app.flushLogs(true);
      for (const result of results) {
        const { source, pod, lastTimestamp } = result.value;
        if (source.handle || source.recoveryController) continue;
        clearTimeout(source.retryTimer);
        source.retryTimer = null;
        source.retryAt = null;
        source.retries = 0; source.connectedAt = null;
        source.pod = pod;
        source.lastTimestamp = lastTimestamp;
        if (pod.terminalContainers?.includes(source.container) || ['Completed', 'Failed'].includes(pod.status)) source.status = 'ended';
        else this.openLogStream(logs, source);
      }
      this.logMessage(logs, t('logs.historyReloaded', { count: history.records.length }));
    } finally {
      this.logClosures.delete(reading);
      logs.reconnecting = false;
      if (app.logs === logs && !app.closing) app.updateHeader();
    }
  }

  async readLogHistory(logs, source, signal, history) {
    const backend = this.app.cluster.backend(logs.profile);
    const pod = await backend.resource(logs.profile, source.pod, signal, { fresh: true });
    if (signal.aborted) throw new DOMException(t('error.requestCancelled'), 'AbortError');
    if (pod.uid !== source.pod.uid) throw new Error(t('logs.podGone', { name: source.pod.name }));
    if (!pod.containers.includes(source.container)) throw new Error(t('logs.containerMissing', { name: source.container }));
    let diagnostic = '';
    let lastTimestamp;
    const handle = backend.logs(logs.profile, pod, source.container, {
      onLine: (text, error) => {
        if (error) diagnostic = (diagnostic + '\n' + text).slice(-8192);
        else {
          history.add(text, false, source);
          const timestamp = /^(\d{4}-\d{2}-\d{2}T\S+)\s/.exec(text)?.[1];
          if (timestamp && Number.isFinite(Date.parse(timestamp))) lastTimestamp = timestamp;
        }
      },
    }, { follow: false, tail: 300 });
    let failure;
    const abort = () => { failure = new DOMException(t('error.requestCancelled'), 'AbortError'); void handle.stop(); };
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      failure ??= new Error(t('error.requestTimeout', { seconds: 25 }));
      void handle.stop();
    }, 25000);
    try {
      if (signal.aborted) abort();
      const result = await handle.done;
      if (failure) throw failure;
      if (result.error || result.code !== 0) throw new Error(result.error?.message || diagnostic.trim() || t('error.kubectlExit', { code: result.code }));
      return { source, pod, lastTimestamp };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      await handle.stop();
    }
  }

  beginLogAction(logs) {
    const app = this.app;
    const controller = app.beginAction();
    logs.actionRequest = controller;
    return controller;
  }

  logMessage(logs, message, error = false) {
    const app = this.app;
    if (app.logs === logs) app.setStatus(message, error);
  }

  logSourceKey(source) {
    return `${source.pod.namespace}/${source.pod.uid ?? source.pod.name}/${source.container}`;
  }

  openLogStream(logs, source) {
    const app = this.app;
    source.status = 'opening';
    source.message = '';
    source.needsReplacement = false;
    source.retryAt = null;
    let diagnostic = '';
    let permanent = false;
    const replay = new Map();
    if (source.lastTimestamp) {
      for (const record of logs.buffer.records) {
        if (!record.error && this.logSourceKey(record.source) === this.logSourceKey(source)) {
          replay.set(record.text, (replay.get(record.text) ?? 0) + 1);
        }
      }
    }
    source.historyReplay = null;
    let handle;
    const active = () => app.logs === logs && !app.closing && logs.sources.includes(source) && source.handle === handle;
    try {
      handle = app.cluster.backend(logs.profile).logs(logs.profile, source.pod, source.container, {
        onLine: (text, error) => {
          if (!active()) return;
          if (error) {
            diagnostic = (diagnostic + '\n' + text).slice(-8192);
            if (permanentLogError.test(text)) permanent = true;
          }
          if (!error) {
            const timestamp = /^(\d{4}-\d{2}-\d{2}T\S+)\s/.exec(text)?.[1];
            if (timestamp && Number.isFinite(Date.parse(timestamp))) {
              source.lastTimestamp = timestamp;
              if (replay.size || source.historyReplay?.size) {
                const value = limitRecord(text);
                const counts = replay.has(value) ? replay : source.historyReplay;
                const remaining = counts?.get(value) ?? 0;
                if (remaining) {
                  if (remaining === 1) counts.delete(value);
                  else counts.set(value, remaining - 1);
                  return;
                }
              }
            }
          }
          logs.buffer.add(text, error, source);
          source.status = 'live';
          logs.dirty = true;
        },
        onClose: result => {
          if (!active()) return;
          source.handle = null;
          source.status = result.error || result.code ? 'error' : 'ended';
          source.message = result.error ? result.error.code === 'ENOENT' ? t('error.kubectlMissing') : result.error.message :
            result.code ? diagnostic.trim() || t('error.kubectlExit', { code: result.code }) : '';
          if (!result.error && !permanent && !source.pod.terminalContainers?.includes(source.container)) this.scheduleLogRetry(logs, source);
          logs.dirty = true;
          if (source.status === 'error' && source.message) this.logMessage(logs, source.message, true);
          app.updateHeader();
        },
      }, source.lastTimestamp ? { sinceTime: source.lastTimestamp, tail: -1 } : undefined);
      source.handle = handle;
      source.status = 'live';
      source.connectedAt = Date.now();
    } catch (error) {
      source.status = 'error';
      source.message = error.message;
      this.logMessage(logs, error.message, true);
    }
  }

  stopLogSource(source) {
    source.historyReplay = null;
    clearTimeout(source.retryTimer);
    source.retryTimer = null;
    source.retryAt = null;
    source.recoveryController?.abort();
    source.recoveryController = null;
    if (source.stopping) return source.stopping;
    const handle = source.handle;
    source.handle = null;
    const stopping = Promise.resolve(handle?.stop()).finally(() => { if (source.stopping === stopping) source.stopping = null; });
    source.stopping = stopping;
    return stopping;
  }

  scheduleLogRetry(logs, source) {
    const app = this.app;
    if (app.logs !== logs || app.closing || !logs.sources.includes(source) || source.retryTimer) return;
    if (source.connectedAt && Date.now() - source.connectedAt >= 30000) source.retries = 0;
    source.connectedAt = null;
    source.retries = (source.retries ?? 0) + 1;
    const delay = Math.min(3000 * source.retries, 15000);
    source.status = 'retrying';
    source.retryAt = Date.now() + delay;
    source.retryTimer = setTimeout(() => {
      source.retryTimer = null;
      void this.runLogRecovery(logs, source);
    }, delay);
    app.updateHeader();
  }

  runLogRecovery(logs, source, options) {
    const app = this.app;
    const work = this.recoverLogSource(logs, source, options).catch(error => {
      if (app.logs !== logs || app.closing || !logs.sources.includes(source)) return;
      source.status = 'error'; source.message = error.message;
      this.logMessage(logs, source.message, true);
    }).finally(() => this.logClosures.delete(work));
    this.logClosures.add(work);
    return work;
  }

  async replacementPods(logs, source, signal) {
    const app = this.app;
    const backend = app.cluster.backend(logs.profile);
    const service = await backend.resource(logs.profile, source.serviceTarget, signal, { fresh: true });
    const pods = await backend.podsFor(logs.profile, service, signal);
    return pods.filter(pod => !['Completed', 'Succeeded', 'Failed', 'Terminating'].includes(pod.status) &&
      !logs.sources.some(other => other !== source && other.pod.namespace === pod.namespace && other.pod.name === pod.name));
  }

  async replaceLogPod(logs, source, pod, signal) {
    const app = this.app;
    if (pod.compact) pod = await app.cluster.backend(logs.profile).resource(logs.profile, pod, signal, { fresh: true });
    if (signal.aborted || app.closing || app.logs !== logs || !logs.sources.includes(source)) return;
    if (!pod.containers.includes(source.container)) throw new Error(t('logs.containerMissing', { name: source.container }));
    if (logs.sources.some(other => other !== source && this.logSourceKey(other) === this.logSourceKey({ pod, container: source.container }))) {
      source.needsReplacement = Boolean(source.serviceTarget);
      source.status = 'error'; source.message = t('logs.replacementUsed');
      this.logMessage(logs, source.message, true);
      return;
    }
    return this.changeLogSources(logs.sources.map(other => other === source ? { pod, container: source.container, serviceTarget: source.serviceTarget } : other), { automatic: true });
  }

  async recoverLogSource(logs, source, { readHistory = false } = {}) {
    const app = this.app;
    if (app.logs !== logs || app.closing || !logs.sources.includes(source)) return;
    const controller = new AbortController();
    source.recoveryController = controller;
    source.status = 'opening';
    source.retryAt = null;
    app.updateHeader();
    const active = () => !controller.signal.aborted && app.logs === logs && !app.closing && logs.sources.includes(source);
    try {
      let pod;
      try { pod = await app.cluster.backend(logs.profile).resource(logs.profile, source.pod, controller.signal, { fresh: true }); }
      catch (error) {
        if (!missingPod.test(error.message) || !active()) throw error;
        if (!source.serviceTarget) {
          source.status = 'error'; source.message = t('logs.podGone', { name: source.pod.name });
          this.logMessage(logs, source.message, true);
          return;
        }
        const pods = await this.replacementPods(logs, source, controller.signal);
        if (!active()) return;
        if (pods.length === 1) { await this.replaceLogPod(logs, source, pods[0], controller.signal); return; }
        source.needsReplacement = true;
        if (pods.length > 1) {
          source.status = 'error'; source.message = t('logs.replacementChoice');
          this.logMessage(logs, source.message, true);
        } else this.scheduleLogRetry(logs, source);
        return;
      }
      if (!active()) return;
      if (pod.uid !== source.pod.uid) { await this.replaceLogPod(logs, source, pod, controller.signal); return; }
      source.pod = pod;
      if (!pod.containers.includes(source.container)) {
        source.status = 'error'; source.message = t('logs.containerMissing', { name: source.container });
        this.logMessage(logs, source.message, true);
      } else if (!readHistory && (pod.terminalContainers.includes(source.container) || ['Completed', 'Failed'].includes(pod.status))) source.status = 'ended';
      else if (!source.handle) this.openLogStream(logs, source);
    } catch (error) {
      if (!active() || error.name === 'AbortError') return;
      source.message = error.message;
      if (permanentLogError.test(error.message) || error.message === t('logs.containerMissing', { name: source.container })) {
        source.status = 'error'; this.logMessage(logs, source.message, true);
      } else this.scheduleLogRetry(logs, source);
    } finally {
      if (source.recoveryController === controller) source.recoveryController = null;
      if (app.logs === logs && !app.closing) { logs.dirty = true; app.updateHeader(); }
    }
  }
}
