import { fileProfile } from './kube.js';
import { validNamespace } from './config.js';
import { t } from './i18n/index.js';
import { oneLine } from './text.js';

export class ClusterSession {
  constructor(app) {
    this.app = app;
    this.generation = 0;
  }

  backend(profile = this.app.profile) {
    const app = this.app;
    if (!profile) throw new Error(t('error.noProfile'));
    return app.live;
  }

  profileById(id) {
    const app = this.app;
    const profile = app.profiles.find(item => item.id === id);
    if (!profile) throw new Error(t('error.profileMissing'));
    return profile;
  }

  listKey() {
    const app = this.app;
    return app.profile && ['services', 'pods'].includes(app.tab) ?
      JSON.stringify([app.profile.id, app.profile.file, app.profile.context, app.namespace, app.tab]) : null;
  }

  get currentLoad() {
    return this.loadState?.key === this.listKey() ? this.loadState : null;
  }

  feedback() {
    const state = this.currentLoad;
    if (!state) return { tone: 'muted', message: '' };
    const name = t(`view.${this.app.tab}`);
    const lines = [];
    let tone;
    if (state.phase === 'loading') {
      const seconds = Math.floor((performance.now() - state.started) / 1000);
      const spinner = ['|', '/', '—', '\\'][seconds % 4];
      const automatic = state.background ? t('cluster.automatic') : '';
      lines.push(t(state.previousError ? 'cluster.retrying' : state.previousSuccessAt ? 'cluster.refreshing' : 'cluster.loading',
        { spinner, name, seconds, automatic }));
      if (state.previousError) lines.push(t('cluster.previousError', { reason: state.previousError }));
      if (seconds >= 5) lines.push(t('cluster.slow'));
      tone = seconds >= 5 ? 'warn' : 'accent';
    } else if (state.phase === 'error') {
      lines.push(t('cluster.failed', { name }), state.error);
      tone = 'error';
    } else if (state.phase === 'cancelled') {
      lines.push(t('cluster.cancelled'));
      tone = 'warn';
    } else {
      const time = new Date(state.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      lines.push(t('cluster.updated', { name, count: this.app.rows.length, time }));
      tone = 'good';
    }
    if (state.phase !== 'success' && state.previousSuccessAt) lines.push(t('cluster.previousData'));
    return { tone, message: lines.join('\n') };
  }

  cancelRefresh() {
    if (!this.request || this.request.signal.aborted) return;
    this.generation++;
    this.request.abort();
    this.request = null;
    if (this.loadState?.phase === 'loading') this.loadState.phase = 'cancelled';
    this.nextRefreshAt = Infinity;
    if (!this.app.logs) this.app.resourceTable.renderTable();
    this.app.updateHeader();
  }

  async refresh({ background = false } = {}) {
    const app = this.app;
    const key = this.listKey();
    if (background && this.request && !this.request.signal.aborted && this.loadState?.key === key) return;
    this.request?.abort();
    this.request = null;
    const generation = ++this.generation;
    const previous = this.currentLoad;
    if (!key) this.loadState = null;
    if (['favorites', 'forwards', 'groups'].includes(app.tab)) { app.resourceTable.renderTable(); app.updateHeader(); return; }
    if (!app.profile) { app.rows = []; app.resourceTable.renderTable(); app.updateHeader(); return; }
    if (!background) { this.backend().clearCache(); app.podDetail = null; this.cancelPodDetails(); }
    const controller = new AbortController();
    this.request = controller;
    const started = performance.now();
    this.loadState = { key, phase: 'loading', started, background,
      previousError: previous?.phase === 'error' ? previous.error : undefined,
      previousSuccessAt: previous?.phase === 'success' ? previous.completedAt : previous?.previousSuccessAt };
    app.updateHeader();
    if (!app.logs) app.resourceTable.renderTable();
    if (!background) app.setStatus('');
    try {
      const rows = await this.backend().list(app.profile, app.namespace, app.tab === 'pods' ? 'pod' : 'service', controller.signal);
      if (generation !== this.generation || app.closing) return;
      app.rows = rows.sort((left, right) => left.namespace.localeCompare(right.namespace) || left.name.localeCompare(right.name));
      this.loadState.phase = 'success';
      this.loadState.completedAt = Date.now();
      if (!app.logs) app.resourceTable.renderTable();
    } catch (error) {
      if (generation !== this.generation || error.name === 'AbortError' || app.closing) return;
      this.loadState.phase = 'error';
      this.loadState.error = oneLine(error.message).slice(0, 320);
      if (!app.logs) app.resourceTable.renderTable();
    } finally {
      if (this.request === controller) {
        this.request = null;
        this.nextRefreshAt = Date.now() + Math.max(8000, 8 * (performance.now() - started));
        app.updateHeader();
      }
    }
  }

  cancelPodDetails() {
    clearTimeout(this.podDetailTimer);
    this.podDetailTimer = null;
    this.podDetailRequest?.controller.abort();
    this.podDetailRequest = null;
    this.podDetailTarget = null;
  }

  schedulePodDetails(item) {
    const app = this.app;
    if (!item?.compact || !app.profile || app.logs || app.small || app.closing ||
      app.modal || !app.sidebar.visible) { this.cancelPodDetails(); return; }
    const profile = { ...app.profile };
    const backend = this.backend(profile);
    const key = backend.resourceKey(profile, item);
    if (this.podDetailTarget !== key) this.cancelPodDetails();
    this.podDetailTarget = key;
    if (this.podDetailRequest || this.podDetailTimer || app.podDetail?.key === key && Date.now() - app.podDetail.at < 30000) return;
    this.podDetailTimer = setTimeout(async () => {
      this.podDetailTimer = null;
      const controller = new AbortController();
      this.podDetailRequest = { key, controller };
      try {
        const value = await backend.resource(profile, item, controller.signal);
        if (!controller.signal.aborted && !app.closing && this.podDetailTarget === key) {
          app.podDetail = { key, value, at: value.detailsAt };
        }
      } catch (error) {
        if (error.name !== 'AbortError' && !app.closing && this.podDetailTarget === key) {
          app.podDetail = { key, error: error.message, at: Date.now() };
        }
      } finally {
        if (this.podDetailRequest?.controller === controller) {
          this.podDetailRequest = null;
          app.resourceTable.updateDetails();
        }
      }
    }, 200);
  }

  async connect(candidate, initial = false) {
    const app = this.app;
    if (app.closing) return;
    const sourceModal = app.modal;
    const controller = app.beginAction();
    app.setStatus(t('status.resolving'));
    const source = { ...candidate, name: candidate.name || fileProfile(candidate.file).name };
    const resolved = await this.backend(source).resolveProfile(source, controller.signal);
    if (controller.signal.aborted || app.closing) return;
    const saved = app.store.data.profiles.find(profile => profile.file === resolved.file && profile.context === resolved.context);
    if (saved) { resolved.id = saved.id; if (!candidate.namespace) resolved.namespace = saved.namespace; }
    if (initial && app.options.namespace) resolved.namespace = app.options.namespace;
    if (resolved.namespace !== '*' && !validNamespace(resolved.namespace)) throw new Error(t('error.namespace'));
    const activate = async () => {
      if (controller.signal.aborted || app.closing) return;
      app.switching = true;
      try {
        const unchanged = saved && ['id', 'file', 'context', 'name', 'namespace', 'mode'].every(key => saved[key] === resolved[key]);
        if (resolved.mode === 'live' && !unchanged) await app.persist(data => { data.profiles = [...data.profiles.filter(profile => profile.id !== resolved.id), resolved]; return data; });
        if (controller.signal.aborted || app.closing) return;
        const changingProfile = app.profile && ['id', 'file', 'context'].some(key => app.profile[key] !== resolved[key]);
        this.request?.abort();
        this.request = null;
        this.loadState = null;
        this.generation++;
        await app.closeLogs();
        if (changingProfile && app.profile.id === resolved.id) await app.forwards.stopProfile(resolved.id);
        if (controller.signal.aborted || app.closing) return;
        app.profile = resolved;
        app.resourceTable.relatedIndex = null;
        app.namespace = initial && app.options.namespace ? app.options.namespace : resolved.namespace;
        if (app.namespace !== '*' && !validNamespace(app.namespace)) throw new Error(t('error.namespace'));
        app.rows = [];
        app.filter.value = '';
        app.resourceTable.renderTable();
        app.updateHeader();
        await app.store.saveState({ lastProfileId: resolved.id });
      } finally { app.switching = false; }
      if (controller.signal.aborted || app.closing) return;
      if (sourceModal?.busy && app.modal === sourceModal) app.closeModal();
      app.setStatus('');
      await this.refresh();
      if (!controller.signal.aborted && !app.closing && app.awaitingInitialProfile) {
        app.awaitingInitialProfile = false;
        await app.startAutomaticGroups();
      }
    };
    await activate();
  }

  async disconnectProfile() {
    const app = this.app;
    app.beginAction();
    this.request?.abort();
    this.request = null;
    this.loadState = null;
    this.generation++;
    await app.closeLogs();
    app.profile = null;
    app.resourceTable.relatedIndex = null;
    app.namespace = app.options.namespace ?? 'default';
    app.rows = [];
    app.tab = 'services';
    app.filter.value = '';
    await app.store.saveState({ lastProfileId: undefined });
    app.resourceTable.renderTable();
    app.updateHeader();
    app.setStatus(t('status.noProfile'));
  }

  async applyNamespace(value) {
    const app = this.app;
    if (!app.profile) throw new Error(t('error.noProfile'));
    if (value !== '*' && !validNamespace(value)) throw new Error(t('error.namespace'));
    const controller = app.beginAction();
    const profileId = app.profile.id;
    if (app.profile.mode === 'live' && !app.store.readOnly && !app.store.damaged) {
      await app.persist(data => { data.profiles = data.profiles.map(profile => profile.id === profileId ? { ...profile, namespace: value } : profile); return data; });
      if (controller.signal.aborted || app.closing || app.profile.id !== profileId) return;
      app.profile = this.profileById(profileId);
    }
    app.namespace = value;
    app.rows = [];
    app.updateHeader();
    await this.refresh();
  }
}
