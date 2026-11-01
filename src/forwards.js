import { EventEmitter } from 'node:events';
import { validateForward } from './config.js';
import { t } from './i18n/index.js';

const permanentForwardError = /forbidden|unauthorized|you must be logged in|address already in use|permission denied|cannot assign requested address|executable file not found|not found in PATH|unknown flag|unknown command|context .*does not exist|no context exists|invalid configuration|error loading config|unable to read (?:client-certificate|client-key|certificate-authority)|certificate (?:has expired|signed by unknown|is not|verify failed)|x509:/i;
const brokenForwardError = /error creating (?:error|forwarding) stream for port|error reading from error stream for port|lost connection to pod/i;
const networkError = /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ENOTFOUND|EOF)\b|network is (?:unreachable|down)|no route to host|connection (?:refused|reset|aborted|timed out)|i\/o timeout|TLS handshake timeout|context deadline exceeded|Client\.Timeout exceeded|no such host|temporary failure in name resolution|server misbehaving|unable to connect to the server/i;

export class ForwardManager extends EventEmitter {
  configurations = [];
  sessions = new Map();
  closing = false;
  groups = new Map();
  suspended = new Set();
  connections = new Map();

  constructor({ profile, resolveProfile, backend }) {
    super();
    this.profile = profile;
    this.resolveProfile = resolveProfile;
    this.backend = backend;
  }

  get records() {
    return this.configurations.map(configuration => {
      const session = this.sessions.get(configuration.id);
      const retry = session?.status === 'retrying' ? session.retryAt ? t('forward.retry', {
        attempt: session.retries, seconds: Math.max(0, Math.ceil((session.retryAt - Date.now()) / 1000)),
      }) : t(session.connection?.offline ? 'forward.networkUnavailable' : 'forward.reconnecting') : '';
      return { ...configuration, profile: (session?.want || session?.handle ? session.profile : null) ?? this.profile(),
        status: session?.status ?? 'stopped', info: [session?.info, retry].filter(Boolean).join('\n'),
        journal: session?.journal ?? [], want: session?.want ?? false };
    });
  }

  replace(configurations) {
    this.configurations = configurations.map(configuration => ({ ...configuration, spec: validateForward(configuration.spec) }));
    const ids = new Set(configurations.map(configuration => configuration.id));
    for (const [id, session] of this.sessions) if (!ids.has(id) && !session.want && !session.handle) this.sessions.delete(id);
    this.emit('change');
  }

  isActive(record) {
    if (record?.forwardIds) return this.groups.has(record.id) || record.forwardIds.some(id => this.isActive({ id }));
    const session = this.sessions.get(record?.id);
    return Boolean(session?.want || session?.status === 'stopping');
  }

  async start(record) {
    const configuration = this.configurations.find(item => item.id === record.id);
    if (this.closing || !configuration || this.suspended.has(record.id)) return;
    const previous = this.sessions.get(record.id);
    if (previous?.want || previous?.handle || previous?.status === 'stopping') return;
    const session = { id: record.id, configuration: structuredClone(configuration), status: 'starting', want: true,
      retries: 0, info: t('status.resolving'), journal: [], controller: new AbortController() };
    this.sessions.set(record.id, session);
    this.emit('change');
    session.pending = (async () => {
      try {
        const profile = this.profile();
        if (!profile) throw new Error(t('error.noProfile'));
        session.profile = Object.freeze({ ...await this.resolveProfile({ ...profile }, session.controller.signal) });
        if (!session.want || this.closing || session.controller.signal.aborted) return;
        session.prepared = await this.backend(session.profile).prepareForward(session.configuration.spec, session.controller.signal);
        if (!session.want || this.closing || session.controller.signal.aborted) return;
        this.watchConnection(session);
        this.launch(session);
      } catch (error) {
        if (!session.want) return;
        session.want = false;
        session.status = error.name === 'AbortError' ? 'stopped' : 'error';
        session.info = error.name === 'AbortError' ? t('forward.stopped') : error.message;
        this.unwatchConnection(session);
        this.emit('change');
      }
    })();
    await session.pending;
  }

  watchConnection(session) {
    const key = JSON.stringify([session.profile.file, session.profile.context]);
    let connection = this.connections.get(key);
    if (!connection) {
      connection = { key, profile: session.profile, sessions: new Set(), failures: 0, offline: false };
      this.connections.set(key, connection);
      this.scheduleConnectionCheck(connection);
    }
    connection.sessions.add(session);
    session.connection = connection;
  }

  unwatchConnection(session) {
    const connection = session.connection;
    if (!connection) return;
    session.connection = null;
    connection.sessions.delete(session);
    if (connection.sessions.size) return;
    clearTimeout(connection.timer);
    connection.controller?.abort();
    this.connections.delete(connection.key);
    return connection.pending;
  }

  scheduleConnectionCheck(connection) {
    if (this.closing || this.connections.get(connection.key) !== connection) return;
    connection.timer = setTimeout(() => {
      connection.timer = null;
      connection.pending = this.checkConnection(connection);
    }, 5000);
    connection.timer.unref();
  }

  async checkConnection(connection) {
    const controller = new AbortController();
    connection.controller = controller;
    let failure;
    try {
      try { await this.backend(connection.profile).checkConnection(connection.profile, controller.signal); }
      catch (error) {
        if (controller.signal.aborted || error.name === 'AbortError') return;
        if (!permanentForwardError.test(error.message) && networkError.test(`${error.code ?? ''} ${error.message}`)) failure = error;
      }
      if (this.closing || controller.signal.aborted || this.connections.get(connection.key) !== connection) return;
      if (failure) {
        connection.failures++;
        if (connection.failures < 2 || connection.offline) return;
        connection.offline = true;
        connection.reason = failure.message;
        for (const session of connection.sessions) {
          clearTimeout(session.timer);
          session.timer = null;
          session.retryAt = null;
          session.info = connection.reason;
          if (session.handle) this.restart(session, connection.reason);
          else this.scheduleRetry(session);
        }
      } else {
        connection.failures = 0;
        if (!connection.offline) return;
        connection.offline = false;
        for (const session of connection.sessions) if (!session.handle) this.scheduleRetry(session);
      }
    } finally {
      if (connection.controller === controller) connection.controller = null;
      this.scheduleConnectionCheck(connection);
    }
  }

  scheduleRetry(session) {
    if (this.closing || !session.want || session.handle || session.timer) return;
    if (session.connectedAt && Date.now() - session.connectedAt >= 30000) session.retries = 0;
    session.connectedAt = null;
    session.status = 'retrying';
    session.retryAt = null;
    if (!session.connection?.offline) {
      session.retries++;
      const delay = Math.min(2000 * session.retries, 15000);
      session.retryAt = Date.now() + delay;
      session.timer = setTimeout(() => { session.timer = null; this.launch(session); }, delay);
    }
    this.emit('change');
  }

  restart(session, reason) {
    if (this.closing || !session.want || !session.handle || session.restarting) return;
    session.restarting = true;
    session.status = 'retrying';
    session.retryAt = null;
    session.info = reason;
    if (session.journal.at(-1) !== reason) {
      session.journal.push(reason);
      if (session.journal.length > 80) session.journal.shift();
    }
    clearTimeout(session.startupTimer);
    this.emit('change');
    void session.handle.stop();
  }

  launch(session) {
    if (this.closing || !session.want || session.handle) return;
    if (session.connection?.offline) { session.info = session.connection.reason; this.scheduleRetry(session); return; }
    session.status = 'starting';
    session.retryAt = null;
    session.connectedAt = null;
    session.restarting = false;
    session.info = t('forward.waiting');
    let permanent = false;
    let diagnostic = '';
    let handle;
    try {
      handle = this.backend(session.profile).forward(session.profile, session.configuration.spec, {
        onLine: (line, isError) => {
          if (session.handle !== handle || !session.want || session.restarting) return;
          session.journal.push(line);
          if (session.journal.length > 80) session.journal.shift();
          session.info = line;
          if (isError) diagnostic = line;
          if (!isError && /^Forwarding from /.test(line)) {
            session.connectedAt ??= Date.now();
            session.status = 'running';
            permanent = false;
            if (session.connection) session.connection.failures = 0;
            clearTimeout(session.startupTimer);
          }
          if (isError && !session.connectedAt && permanentForwardError.test(line)) permanent = true;
          if (isError && !permanent && brokenForwardError.test(line)) { this.restart(session, line); return; }
          this.emit('change');
        },
        onClose: ({ code, error }) => {
          if (session.handle !== handle) return;
          clearTimeout(session.startupTimer);
          session.handle = null;
          if (error) { permanent = true; session.info = error.code === 'ENOENT' ? t('error.kubectlMissing') : error.message; }
          else if (session.want && !session.restarting) session.info = diagnostic || t('forward.disconnected');
          if (!this.closing && session.want && !permanent) {
            this.scheduleRetry(session);
            return;
          }
          session.status = session.want ? 'error' : 'stopped';
          if (session.want && !session.info) session.info = t('error.kubectlExit', { code });
          session.want = false;
          this.unwatchConnection(session);
          this.emit('change');
        },
      }, session.prepared);
    } catch (error) {
      session.want = false;
      session.status = 'error';
      session.info = error.message;
      this.unwatchConnection(session);
      this.emit('change');
      return;
    }
    session.handle = handle;
    session.startupTimer = setTimeout(() => {
      if (session.handle !== handle || session.status !== 'starting') return;
      this.restart(session, t('forward.timeout'));
    }, 30000);
    this.emit('change');
  }

  async stop(record) {
    const session = this.sessions.get(record.id);
    if (!session) return;
    if (session.stopping) return session.stopping;
    session.want = false;
    session.status = 'stopping';
    session.controller.abort();
    clearTimeout(session.timer);
    session.timer = null;
    clearTimeout(session.startupTimer);
    const monitoring = this.unwatchConnection(session);
    this.emit('change');
    session.stopping = (async () => {
      await session.pending;
      await session.handle?.stop();
      await monitoring;
      session.status = 'stopped';
      session.info = t('forward.stopped');
      this.emit('change');
    })();
    return session.stopping;
  }

  async stopAll() {
    this.groups.clear();
    await Promise.all([...this.sessions.keys()].map(id => this.stop({ id })));
    this.sessions.clear();
    this.emit('change');
  }

  async suspend(record) { this.suspended.add(record.id); await this.stop(record); }
  resume(record) { this.suspended.delete(record.id); }

  async startGroup(group) {
    if (this.groups.has(group.id)) return;
    const operation = { forwardIds: [...group.forwardIds] };
    this.groups.set(group.id, operation);
    try {
      for (const id of group.forwardIds) {
        if (this.closing || this.groups.get(group.id) !== operation) return;
        await this.start({ id });
      }
    } finally { if (this.groups.get(group.id) === operation) this.groups.delete(group.id); }
  }

  async stopGroup(group) { this.groups.delete(group.id); await Promise.all(group.forwardIds.map(id => this.stop({ id }))); }

  async close() {
    this.closing = true;
    this.groups.clear();
    this.closed ??= Promise.all([...this.sessions.keys()].map(id => this.stop({ id })));
    await this.closed;
  }
}
