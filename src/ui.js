import {
  InputRenderable, ScrollBoxRenderable,
  createCliRenderer, createHostClipboard, createClipboard, createRendererClipboardAdapter,
} from '@opentui/core';
import stringWidth from 'string-width';
import { ProcessPool } from './processes.js';
import { KubeBackend, discoverProfiles, fileProfile } from './kube.js';
import { PrivilegedPorts, authorizeSudo } from './privileged.js';
import { ForwardManager } from './forwards.js';
import { oneLine } from './text.js';
import { commandKey } from './controls.js';
import { KeyboardNavigation } from './navigation.js';
import { t } from './i18n/index.js';
import { SettingsStore } from './storage.js';
import { LogBuffer } from './logs.js';
import { LogViewport } from './log-viewport.js';
import { ManagementDialogs } from './management.js';
import { ClusterSession } from './cluster-session.js';
import { LogStreams } from './log-streams.js';
import { ResourceTable } from './resource-table.js';
import { AppCommands } from './commands.js';

const themes = {
  dark: { background: '#10151d', panel: '#151d28', input: '#202c3b', text: '#d9e2ef', muted: '#94a3b8', line: '#364152', accent: '#7cb8ff', selected: '#244369', error: '#ff919a', warn: '#d6a08a', good: '#8cd9b1', mark: '#49352e' },
  light: { background: '#f4f6f9', panel: '#ffffff', input: '#e8edf4', text: '#182335', muted: '#52647b', line: '#b7c4d4', accent: '#1755a0', selected: '#cfe2fa', error: '#a51e36', warn: '#805600', good: '#176b45', mark: '#ffdf8a' },
};
const tabs = ['cluster', 'favorites', 'forwards', 'groups'];
const clusterTabs = ['services', 'pods'];

export class KuberikonApp extends ManagementDialogs {
  constructor(renderer, options, version, store) {
    super();
    this.store = store;
    this.renderer = renderer;
    this.options = options;
    this.version = version;
    this.colors = themes[options.theme];
    this.cluster = new ClusterSession(this);
    this.logStreams = new LogStreams(this);
    this.resourceTable = new ResourceTable(this);
    this.commands = new AppCommands(this);
    this.pool = new ProcessPool();
    this.privileged = new PrivilegedPorts((port, signal) => this.authorizePort(port, signal));
    this.live = new KubeBackend(this.pool, this.privileged);
    this.forwards = new ForwardManager({ profile: configuration => this.profilesById.get(configuration.profileId),
      resolveProfile: (profile, signal) => this.cluster.backend(profile).resolveProfile(profile, signal), backend: profile => this.cluster.backend(profile) });
    this.clipboard = createClipboard({ host: createHostClipboard(), terminal: createRendererClipboardAdapter(renderer) });
    this.profile = null;
    this.namespace = options.namespace ?? 'default';
    this.tab = 'services';
    this.runningOnly = false;
    this.clusterTab = 'services';
    this.queries = { favorites: '', forwards: '', services: '', pods: '', groups: '' };
    this.selected = {};
    this.rows = [];
    this.visibleRows = [];
    this.rowViews = [];
    this.discovered = [];
    this.profiles = [...store.data.profiles];
    this.profilesById = new Map(this.profiles.map(profile => [profile.id, profile]));
    this.forwards.replace(store.data.forwards);
    this.logGeneration = 0;
    this.navigation = new KeyboardNavigation(this);
    this.buildLayout();
    this.navigation.controls().forEach(control => this.navigation.watch(control));
    this.forwards.on('change', () => this.scheduleUpdate());
    this.renderer.on('resize', () => this.resize());
    this.renderer.keyInput.on('keypress', key => this.handleKey(key));
    this.renderer.keyInput.on('paste', event => this.handleLogPaste(event));
    this.logTimer = setInterval(() => this.flushLogs(), 150);
    this.clockTimer = setInterval(() => this.tick(), 1000);
    this.signalHandlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => {
      const handler = () => { void this.shutdown(); };
      process.on(signal, handler);
      return [signal, handler];
    }));
  }

  clear(parent) {
    for (const child of [...parent.getChildren()]) { parent.remove(child); child.destroyRecursively(); }
  }

  buildLayout() {
    const color = this.colors;
    this.root = this.box(this.renderer.root, { width: '100%', height: '100%', backgroundColor: color.background });
    const header = this.box(this.root, { height: 2, flexShrink: 0, flexDirection: 'row', alignItems: 'center', paddingX: 1, gap: 1, backgroundColor: color.panel });
    this.profileText = this.text(header, '', { flexGrow: 1, flexShrink: 1, minWidth: 1, wrapMode: 'none', truncate: true });
    this.modeText = this.text(header, '', { width: 'auto', flexShrink: 0, textAlign: 'right', fg: color.accent });
    this.tabBar = this.box(this.root, { height: 1, flexShrink: 0, flexDirection: 'row', paddingX: 1, gap: 1 });
    this.tabBoxes = tabs.map(tab => this.action(this.tabBar, t(`tab.${tab}`), () => this.switchTab(tab)));
    this.directoryBanner = this.box(this.root, { height: 3, flexShrink: 0, marginX: 1, border: true,
      borderColor: color.line, flexDirection: 'row', alignItems: 'center', paddingX: 1 });
    this.directoryMessage = this.text(this.directoryBanner, t('profile.directoryBanner'), { flexGrow: 1, wrapMode: 'word', fg: color.muted });
    this.directoryButton = this.action(this.directoryBanner, t('settings.setFolder'), () => this.editProfilesDirectory());
    this.filterRow = this.box(this.root, { height: 2, flexShrink: 0, paddingX: 1, flexDirection: 'row', alignItems: 'center', gap: 1 });
    this.resourceButtons = clusterTabs.map(tab => this.action(this.filterRow, t(`view.${tab}`), () => this.switchTab(tab), { shortcut: tab[0], showShortcut: true }));
    this.resourceButtons.forEach(button => { button.visible = false; });
    this.filter = this.input({ width: 'auto', flexGrow: 1, flexShrink: 1, minWidth: 1, value: '', placeholder: t('list.filter'), maxLength: 160 });
    this.filterRow.add(this.filter);
    this.logFilterButton = this.action(this.filterRow, t('logs.highlightMode'), () => this.toggleLogFilter());
    this.logFilterButton.visible = false;
    this.filter.on('input', () => {
      if (this.logs) {
        this.logViewport.setQuery(this.filter.value);
        if (this.logViewport.currentMatch?.sourceOnly) this.setStatus(t('logs.sourceMatch'));
        this.updateHeader();
      }
      else { this.queries[this.tab] = this.filter.value; this.resourceTable.renderTable(); }
    });
    this.filter.on('focused', () => this.updateHeader());
    this.filter.on('blurred', () => this.updateHeader());
    this.resourceNotice = this.message(this.root, '', { visible: false, height: 'auto', marginX: 1,
      paddingX: 1, backgroundColor: color.panel });
    this.body = this.box(this.root, { flexGrow: 1, minHeight: 1, flexDirection: 'row', paddingX: 1, gap: 1 });
    this.listPanel = this.box(this.body, { flexGrow: 1, minWidth: 1, border: true, borderColor: color.line, titleColor: color.muted });
    this.tableHeader = this.text(this.listPanel, '', { height: 1, flexShrink: 0, width: '100%', fg: color.muted, wrapMode: 'none' });
    this.table = new ScrollBoxRenderable(this.renderer, { flexGrow: 1, minHeight: 1, width: '100%',
      scrollX: false, scrollY: true, viewportCulling: true, contentOptions: { flexDirection: 'column' } });
    this.listPanel.add(this.table);
    this.table.viewport.on('resize', () => {
      if (!this.closing && !this.logs && !this.small) this.resourceTable.renderTable();
    });
    this.table.on('focused', () => { this.listPanel.borderColor = color.accent; this.resourceTable.paintSelection(); });
    this.table.on('blurred', () => { this.listPanel.borderColor = color.line; this.resourceTable.paintSelection(); });
    this.sidebar = new ScrollBoxRenderable(this.renderer, { width: 40, flexShrink: 0, border: true, focusable: true,
      borderColor: color.line, focusedBorderColor: color.accent, title: t('details.title'), titleColor: color.muted, paddingX: 1, scrollX: false });
    this.body.add(this.sidebar);
    this.detailText = this.text(this.sidebar, '', { width: '100%', wrapMode: 'word', selectable: true, flexShrink: 0 });
    this.logPanel = this.box(this.root, { visible: false, flexGrow: 1, minHeight: 1, marginX: 1,
      border: true, borderColor: color.line, flexDirection: 'column' });
    this.logStatus = this.box(this.logPanel, { height: 1, flexShrink: 0, flexDirection: 'row', gap: 1 });
    this.logConnection = this.text(this.logStatus, '', { height: 1, flexGrow: 1, minWidth: 1,
      wrapMode: 'none', truncate: true });
    this.logFollow = this.text(this.logStatus, '', { height: 1, flexShrink: 0, wrapMode: 'none',
      truncate: true, textAlign: 'right' });
    this.logMeta = this.text(this.logPanel, '', { height: 1, flexShrink: 0, width: '100%', wrapMode: 'none', truncate: true, fg: color.muted });
    this.logViewport = new LogViewport(this.renderer, { colors: color, onChange: () => this.onLogViewChanged() });
    this.logPanel.add(this.logViewport);
    this.logViewport.on('focused', () => { this.logPanel.borderColor = color.accent; });
    this.logViewport.on('blurred', () => { this.logPanel.borderColor = color.line; });
    this.smallPanel = this.box(this.root, { visible: false, flexGrow: 1, padding: 1 });
    this.smallText = this.text(this.smallPanel, '', { wrapMode: 'word' });
    this.status = this.message(this.root, '', { visible: false, height: 'auto', width: 'auto', marginX: 1 });
    this.actions = this.buttonRow(this.root, { width: 'auto', marginX: 1 });
    this.keys = this.buttonRow(this.root, { width: 'auto', marginX: 1 });
    this.navigationText = this.text(this.root, '', { height: 1, flexShrink: 0, marginX: 1, fg: color.muted, truncate: true });
    this.resize();
  }

  async authorizePort(port, signal) {
    const request = new AbortController();
    const authorizationSignal = AbortSignal.any([signal, request.signal]);
    let modal;
    let input;
    let label;
    let feedback;
    let cancel;
    let waiting;
    let failed = false;
    const submit = () => {
      if (this.modal !== modal || modal.busy || !waiting) return;
      modal.busy = true;
      input.locked = true;
      feedback.content = t('sudo.checking');
      feedback.fg = this.colors.muted;
      const resolvePassword = waiting;
      waiting = null;
      resolvePassword(input.takePassword());
      this.refreshButtons();
    };
    try {
      if (this.closing || signal.aborted) throw new DOMException(t('error.requestCancelled'), 'AbortError');
      await authorizeSudo(authorizationSignal, ({ user, retry, message, signal: promptSignal }) => {
        if (this.closing || promptSignal.aborted) throw new DOMException(t('error.requestCancelled'), 'AbortError');
        if (!modal) {
          this.renderer.clearSelection();
          modal = this.showModal(t('sudo.title'), { width: 72, height: 13 });
          this.message(modal.dialog, t('sudo.description', { port }), { marginBottom: 1 });
          label = this.label(modal.dialog, '');
          input = this.input({ password: true, selectable: false, maxLength: 4096 });
          modal.dialog.add(input);
          feedback = this.message(modal.dialog, '', { height: 2, marginTop: 1 });
          const buttons = this.buttonRow(modal.dialog, { footer: true });
          cancel = this.button(buttons, t('dialog.cancel'), () => this.cancelModal(), { allowWhileBusy: true });
          const apply = this.button(buttons, t('sudo.authorize'), submit, { primary: true, enabled: () => Boolean(waiting), skipWhenDisabled: true });
          modal.focusables = [input, cancel, apply];
          modal.submit = submit;
          modal.navigationHint = t('sudo.keys');
          modal.onClose = () => request.abort();
          modal.captureKey = key => {
            if (key.name === 'escape' || key.ctrl && key.name === 'c' || failed && ['return', 'kpenter', 'linefeed'].includes(key.name)) {
              this.cancelModal(); return true;
            }
            if (['return', 'kpenter', 'linefeed'].includes(key.name) && this.renderer.currentFocusedRenderable === input || key.ctrl && key.name === 's') {
              submit(); return true;
            }
            return false;
          };
          this.navigationHint(modal);
        }
        modal.busy = false;
        input.locked = false;
        label.content = t('sudo.password', { user: oneLine(user) });
        feedback.content = retry ? oneLine(message) || t('sudo.retry') : '';
        feedback.fg = this.colors.error;
        const password = new Promise((resolvePassword, rejectPassword) => {
          const abort = () => { waiting = null; rejectPassword(new DOMException(t('error.requestCancelled'), 'AbortError')); };
          waiting = value => {
            promptSignal.removeEventListener('abort', abort);
            resolvePassword(value);
          };
          promptSignal.addEventListener('abort', abort, { once: true });
          if (promptSignal.aborted) abort();
        });
        this.navigation.focus(input);
        this.refreshButtons();
        return password;
      });
    } catch (error) {
      if (modal && input && feedback && cancel && this.modal === modal && !this.closing && error.name !== 'AbortError') {
        failed = true;
        modal.busy = false;
        input.locked = true;
        feedback.content = oneLine(error.message);
        feedback.fg = this.colors.error;
        modal.navigationHint = t('sudo.closeKeys');
        modal.focusables = [cancel];
        this.setActionLabel(cancel, t('dialog.close'));
        this.navigation.focus(cancel);
        this.refreshButtons();
      }
      throw error;
    } finally {
      request.abort();
      input?.clearPassword();
      if (modal && this.modal === modal && !failed) this.closeModal();
    }
  }

  beginAction() {
    this.actionRequest?.abort();
    this.actionRequest = new AbortController();
    return this.actionRequest;
  }

  syncStore() {
    this.profiles = [...this.store.data.profiles,
      ...this.discovered.filter(candidate => !this.store.data.profiles.some(profile => profile.file === candidate.file))];
    this.profilesById = new Map(this.profiles.map(profile => [profile.id, profile]));
    this.forwards.replace(this.store.data.forwards);
  }

  async persist(transform) {
    if (this.closing) throw new DOMException(t('error.requestCancelled'), 'AbortError');
    await this.store.update(transform);
    if (this.closing) return;
    this.syncStore();
    if (!this.logs) this.resourceTable.renderTable();
    this.updateHeader();
  }

  async init() {
    if (this.profilesDirectory) {
      try { this.discovered = await discoverProfiles(this.profilesDirectory); this.syncStore(); }
      catch (error) { this.directoryError = error.message; }
    }
    let connected = true;
    if (this.options.kubeconfig) await this.cluster.connect(fileProfile(this.options.kubeconfig), true);
    else if (this.options['profiles-dir']) { connected = false; this.awaitingInitialProfile = true; this.openProfiles(); }
    else {
      const previous = this.profiles.find(profile => profile.id === this.store.state.lastProfileId);
      if (previous) await this.cluster.connect(previous, true);
      else {
        connected = false;
        this.awaitingInitialProfile = true;
        if (this.profiles.length || this.profilesDirectory) this.openProfiles();
        else if (!this.store.readOnly && !this.store.damaged) this.editProfilesDirectory({ initial: true });
      }
    }
    if (this.closing) return;
    if (connected) await this.startAutomaticGroups();
    if (this.store.notices.length) this.setStatus(this.store.notices.join(' '), true);
    else if (this.directoryError) this.setStatus(this.directoryError, true);
    this.updateHeader();
    if (!this.modal) this.table.focus();
  }

  async startAutomaticGroups() {
    if (!this.profile || this.switching || this.didAutostart || this.options['no-autostart'] || this.store.readOnly || this.store.damaged) return;
    this.didAutostart = true;
    const profileId = this.profile.id;
    for (const group of this.store.data.groups.filter(item => item.autostart)) {
      if (this.closing || this.switching || this.profile?.id !== profileId) return;
      await this.startTemplate(group);
    }
  }

  resize() {
    if (this.closing) return;
    this.small = this.renderer.width < 80 || this.renderer.height < 24;
    this.sidebar.visible = this.renderer.width >= 118;
    this.sidebar.width = Math.min(64, Math.max(40, Math.floor(this.renderer.width * 0.35)));
    this.body.visible = !this.logs && !this.small;
    this.logPanel.visible = Boolean(this.logs) && !this.small;
    this.smallPanel.visible = this.small;
    this.smallText.content = t('app.small', { width: this.renderer.width, height: this.renderer.height });
    if (this.modal) {
      this.modal.layer.visible = !this.small;
      this.modal.dialog.width = Math.min(this.modal.width, this.renderer.width - 4);
      this.modal.dialog.maxHeight = Math.max(10, this.renderer.height - 2);
    }
    if (!this.logs) this.resourceTable.renderTable();
    else this.flushLogs(true);
    this.updateHeader();
  }

  updateHeader() {
    if (this.closing) return;
    const shownProfile = this.logs?.profile ?? this.profile;
    const allProfiles = !this.logs && this.tab === 'forwards';
    const active = this.forwards.records.filter(record => record.status === 'running' && (allProfiles || record.profileId === shownProfile?.id)).length;
    const scope = allProfiles ? t('app.allProfiles') : t('app.profile', { name: oneLine(shownProfile?.name ?? t('app.noProfile')) });
    const namespace = this.logs?.sources[0]?.pod.namespace ?? this.namespace;
    const namespaceLabel = this.logs || clusterTabs.includes(this.tab) ? `   ${t('app.namespace', { name: oneLine(namespace) })}` : '';
    this.profileText.content = `${scope}${namespaceLabel}   ${t('app.count', { count: active })}`;
    const readOnly = this.store.readOnly || this.store.damaged;
    const feedback = this.cluster.feedback();
    this.modeText.content = `kuberikon · ${this.version.split('-')[0]}${readOnly ? t('app.readOnlyBadge') : ''}`;
    this.modeText.fg = readOnly ? this.colors.warn : this.colors.accent;
    this.resourceNotice.visible = Boolean(feedback.message) && !this.logs && !this.small;
    this.resourceNotice.content = feedback.message;
    this.resourceNotice.fg = this.colors[feedback.tone];
    this.tabBoxes.forEach((box, index) => {
      const active = tabs[index] === this.tab || tabs[index] === 'cluster' && clusterTabs.includes(this.tab);
      box.actionActive = active;
      this.paintButton(box);
    });
    this.tabBar.visible = !this.logs;
    this.directoryBanner.visible = (!this.profile && !this.profilesDirectory || Boolean(this.directoryError)) && !this.logs && !this.small;
    this.directoryBanner.borderColor = this.directoryError ? this.colors.warn : this.colors.line;
    this.directoryMessage.fg = this.directoryError ? this.colors.warn : this.colors.muted;
    this.directoryMessage.content = this.directoryError ? oneLine(this.directoryError) : t('profile.directoryBanner');
    this.filter.placeholder = t(this.logs ? 'logs.filter' : this.tab === 'favorites' ? 'list.favoriteFilter' : 'list.filter');
    this.logFilterButton.visible = Boolean(this.logs);
    this.resourceButtons.forEach((button, index) => {
      button.visible = !this.logs && clusterTabs.includes(this.tab);
      button.actionActive = this.tab === clusterTabs[index];
      this.paintButton(button);
    });
    this.navigation.refresh();
    if (this.logs) {
      this.setActionLabel(this.logFilterButton, t(this.logViewport.filterOnly ? 'logs.filterMode' : 'logs.highlightMode'));
      this.logFilterButton.actionActive = this.logViewport.filterOnly;
      this.paintButton(this.logFilterButton);
      this.updateLogMeta();
    }
    this.updateActions();
  }

  action(parent, label, action, { allowWhileSwitching = false, enabled, ...options } = {}) {
    return this.button(parent, label, action, { backgroundColor: this.colors.background,
      enabled: () => !this.modal && (!this.switching || allowWhileSwitching) && (!enabled || enabled()), ...options });
  }

  updateActions() {
    const mode = this.logs ? 'logs' : this.tab;
    const commands = this.commands.viewActions();
    if (this.actionMode !== mode) {
      this.actionMode = mode;
      this.clear(this.actions);
      this.clear(this.keys);
      this.actionButtons = commands.map(({ shortcut, message, run, when }) =>
        this.action(this.actions, t(message), run, { shortcut, enabled: when }));
      this.keyButtons = this.commands.commonActions().map(({ shortcut, message, run }) =>
        this.action(this.keys, t(message), run, { shortcut, allowWhileSwitching: shortcut === 'F10' }));
    }
    this.actionButtons.forEach((button, index) => {
      const command = commands[index];
      const visible = !command.when || command.when();
      if (!visible && button.focused) this.table.focus();
      button.visible = visible;
      if (visible) {
        button.actionActive = command.active?.() ?? false;
        this.setActionLabel(button, t(command.message));
      }
    });
  }

  requestQuit() {
    if (this.closing || this.modal?.exitConfirmation) return;
    const active = this.forwards.records.filter(record => record.want).length;
    if (active) {
      this.confirm(t('quit.title'), t('quit.text', { count: active }), t('quit.confirm'), () => this.shutdown());
      this.modal.exitConfirmation = true;
    } else void this.shutdown();
  }

  editCurrent() {
    if (!['forwards', 'groups'].includes(this.tab)) return;
    const item = this.resourceTable.current();
    if (item?.spec) return this.forwardForm(item.spec, { record: item });
    else if (item?.forwardIds) this.editGroup(item);
  }

  deleteCurrent() {
    if (!['forwards', 'groups'].includes(this.tab)) return;
    const item = this.resourceTable.current();
    if (item?.spec) this.deleteForward(item);
    else if (item?.forwardIds) this.deleteGroup(item);
  }

  controlCurrent(record = this.resourceTable.current(), start) {
    if (record?.forwardIds) {
      const group = this.templateGroup(record);
      return this.forwards.isActive(group) ? this.forwards.stopGroup(group) : this.startTemplate(record);
    }
    if (!record?.spec) { this.setStatus(t('status.startHint')); return; }
    record = this.forwards.records.find(item => item.id === record.id);
    if (!record) return;
    if (record.status === 'stopping') return;
    return (start ?? !record.want) ? this.forwards.start(record) : this.forwards.stop(record);
  }

  tick() {
    if (this.closing) return;
    if (this.statusExpiresAt && Date.now() >= this.statusExpiresAt) this.setStatus('');
    if (this.cluster.currentLoad?.phase === 'loading') this.updateHeader();
    this.refreshButtons();
    if (!this.logs && !this.small) {
      const retrying = [...this.forwards.sessions.values()].some(session => session.status === 'retrying');
      if (retrying) this.resourceTable.relatedIndex = null;
      if (this.tab === 'forwards' && retrying) {
        const records = new Map(this.forwards.records.map(record => [record.id, record]));
        this.visibleRows = this.visibleRows.map(record => ({ ...record, ...records.get(record.id) }));
      }
      if (this.tab === 'pods' || this.tab === 'forwards' && retrying) this.resourceTable.updateRowLabels();
      this.resourceTable.updateDetails();
    }
    if (this.logs?.sources.some(source => source.status === 'retrying')) this.updateLogMeta();
    if (!this.renderer.hasSelection) this.modal?.refresh?.();
    if (this.profile && ['services', 'pods'].includes(this.tab) && !this.logs && !this.modal && !this.small &&
      !this.switching && !this.cluster.request && this.renderer.currentFocusedRenderable !== this.filter && Date.now() >= (this.cluster.nextRefreshAt ?? 0)) {
      void this.perform(() => this.cluster.refresh({ background: true }));
    }
  }

  setStatus(value, error = false) {
    if (this.closing) return;
    const message = oneLine(value).slice(0, 420);
    this.status.content = message;
    this.status.visible = Boolean(message);
    this.status.fg = error ? this.colors.error : this.colors.muted;
    this.statusExpiresAt = message && !error ? Date.now() + Math.max(8000, message.length * 50) : null;
  }

  perform(task) {
    return Promise.resolve().then(task).catch(error => {
      if (error.name !== 'AbortError' && !this.closing) this.setStatus(error.message, true);
    });
  }

  scheduleUpdate() {
    this.resourceTable.relatedIndex = null;
    if (this.logs?.kind === 'forward') this.logs.dirty = true;
    if (this.pendingUpdate || this.closing) return;
    this.pendingUpdate = setImmediate(() => {
      this.pendingUpdate = null;
      if (this.closing) return;
      if (!this.logs) {
        if (['forwards', 'groups'].includes(this.tab)) this.resourceTable.renderTable();
        else { this.resourceTable.updateRowLabels(); this.resourceTable.updateDetails(); }
      }
      this.updateHeader();
      if (!this.renderer.hasSelection) this.modal?.refresh?.();
    });
  }

  async switchTab(tab) {
    if (this.logs || this.modal || this.closing || this.switching) return;
    if (tab === 'cluster') tab = this.clusterTab;
    if (clusterTabs.includes(tab)) this.clusterTab = tab;
    if (this.tab === tab) return;
    this.beginAction();
    this.cluster.cancelPodDetails();
    this.queries[this.tab] = this.filter.value;
    this.tab = tab;
    this.rows = [];
    this.filter.value = this.queries[tab];
    this.resourceTable.renderTable();
    this.table.focus();
    this.updateHeader();
    await this.perform(() => this.cluster.refresh());
  }

  async chooseNamespace() {
    if (!this.profile) { this.openProfiles(); return; }
    const controller = this.beginAction();
    let names = [];
    try { names = await this.cluster.backend().namespaces(this.profile, controller.signal); }
    catch (error) { if (error.name === 'AbortError') return; this.setStatus(t('namespace.fallback')); }
    if (controller.signal.aborted || this.closing) return;
    this.pick(t('namespace.title'), [
      { name: t('namespace.manual'), description: '', value: null },
      { name: t('namespace.all'), description: '', value: '*' },
      ...names.map(name => ({ name, description: '', value: name })),
    ], value => {
      if (value !== null) return this.cluster.applyNamespace(value);
      this.inputDialog(t('namespace.pathTitle'), t('namespace.name'), this.namespace, value => {
        if (value !== '*' && !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value)) throw new Error(t('error.namespace'));
        return this.cluster.applyNamespace(value);
      }, t('namespace.hint'));
    });
  }

  async viewLogs(item = this.resourceTable.current()) {
    if (!item || item.forwardIds) { this.setStatus(t('status.noResource')); return; }
    if (!this.profile && !item.profile) { this.openProfiles(); return; }
    const controller = this.beginAction();
    const resourceFavorite = Boolean(item.favorite);
    const sourceProfile = item.spec ? item.profile : this.profile;
    if (!sourceProfile) throw new Error(t(item.profileId ? 'error.profileMissing' : 'error.forwardProfile'));
    const profile = item.spec || resourceFavorite ? await this.cluster.backend(sourceProfile).resolveProfile({ ...sourceProfile }, controller.signal) : { ...sourceProfile };
    const backend = this.cluster.backend(profile);
    const reference = resourceFavorite ? item.favorite.target : item.spec ?? item;
    const target = item.spec || item.compact || resourceFavorite ?
      await backend.resource(profile, reference, controller.signal, { fresh: resourceFavorite }) : item;
    const pods = target.kind === 'pod' ? [target] : await backend.podsFor(profile, target, controller.signal);
    if (controller.signal.aborted || this.closing) return;
    if (!pods.length) throw new Error(t('logs.noPods'));
    const selectPod = async pod => {
      if (controller.signal.aborted || this.closing) return;
      const selected = await Promise.all((pod === 'all' ? pods : [pod]).map(candidate =>
        candidate.compact ? backend.resource(profile, candidate, controller.signal) : candidate));
      if (controller.signal.aborted || this.closing) return;
      if (selected.some(item => !item.containers.length)) throw new Error(t('logs.noContainers'));
      return this.startLogSources(profile, selected.map(item => ({ pod: item, container: item.defaultContainer ?? item.containers[0],
        serviceTarget: target.kind === 'service' ? { kind: target.kind, name: target.name, namespace: target.namespace } : undefined })),
        { target });
    };
    if (pods.length === 1) await selectPod(pods[0]);
    else this.pick(t('logs.choosePod'), [
      ...(pods.length <= 16 ? [{ name: t('logs.allPods', { count: pods.length }), description: '', value: 'all' }] : []),
      ...pods.map(pod => ({ name: pod.name, description: `${pod.ready} · ${pod.status}`, value: pod })),
    ], selectPod);
  }

  async startLogSources(profile, sources, { target } = {}) {
    if (this.closing || !sources.length || sources.length > 16) return;
    const controller = this.beginAction();
    const generation = ++this.logGeneration;
    await this.closeLogs(false);
    if (this.closing || generation !== this.logGeneration || controller.signal.aborted) return;
    const logs = { profile: Object.freeze({ ...profile }), sources: [], target,
      buffer: new LogBuffer(), dirty: true, pausedAt: 0, wasFollowing: true };
    this.renderer.clearSelection();
    this.logViewport.reset();
    this.logs = logs;
    this.cluster.cancelPodDetails();
    this.savedFilter = this.filter.value;
    this.filter.value = '';
    this.body.visible = false;
    this.logPanel.visible = !this.small;
    this.setStatus(t('logs.loading'));
    await this.logStreams.changeLogSources(sources);
    if (this.logs === logs) this.logViewport.focus();
  }

  async chooseReplacementPod() {
    const logs = this.logs;
    const sources = logs?.sources.filter(source => source.needsReplacement && source.serviceTarget) ?? [];
    if (!sources.length) return;
    const choose = async source => {
      if (this.logs !== logs || !logs.sources.includes(source)) return;
      const controller = this.logStreams.beginLogAction(logs);
      const pods = await this.logStreams.replacementPods(logs, source, controller.signal);
      if (controller.signal.aborted || this.logs !== logs || !logs.sources.includes(source)) return;
      if (!pods.length) { this.setStatus(t('logs.noPods')); return; }
      this.pick(t('logs.replacePod'), pods.map(pod => ({ name: pod.name, description: `${pod.ready} · ${pod.status}`, value: pod })),
        pod => this.logStreams.replaceLogPod(logs, source, pod, controller.signal));
    };
    if (sources.length === 1) return choose(sources[0]);
    this.pick(t('logs.replacePod'), sources.map(source => ({ name: source.pod.name, description: source.container, value: source })), choose);
  }

  async addLogPod() {
    const logs = this.logs;
    if (!logs || logs.sources.length >= 16) throw new Error(t('error.logSources'));
    const controller = this.logStreams.beginLogAction(logs);
    const pods = await this.cluster.backend(logs.profile).list(logs.profile, logs.sources[0].pod.namespace, 'pod', controller.signal);
    if (controller.signal.aborted || this.closing || this.logs !== logs) return;
    const available = pods.filter(pod => !logs.sources.some(source => source.pod.name === pod.name));
    if (!available.length) throw new Error(t('logs.noPods'));
    this.pick(t('logs.addPod'), available.map(pod => ({ name: pod.name, description: pod.status, value: pod })), async candidate => {
      if (this.logs !== logs) return;
      const request = this.logStreams.beginLogAction(logs);
      const pod = await this.cluster.backend(logs.profile).resource(logs.profile, candidate, request.signal);
      if (request.signal.aborted || this.closing || this.logs !== logs) return;
      if (!pod.containers.length) throw new Error(t('logs.noContainers'));
      return this.logStreams.changeLogSources([...logs.sources, { pod, container: pod.defaultContainer ?? pod.containers[0] }]);
    });
  }

  chooseLogSources() {
    const logs = this.logs;
    if (!logs) return;
    this.pick(t('logs.sourcesTitle'), [
      ...(logs.target?.kind === 'service' ? [{ name: t('logs.choosePod'), description: '', value: 'pod' }] : []),
      { name: t('logs.chooseContainer'), description: '', value: 'container' },
      ...(logs.sources.length < 16 ? [{ name: t('logs.addPod'), description: '', value: 'add' }] : []),
      ...(logs.sources.length > 1 ? [{ name: t('logs.removePod'), description: '', value: 'remove' }] : []),
      ...(logs.sources.some(source => source.needsReplacement && source.serviceTarget) ? [{ name: t('logs.replacePod'), description: '', value: 'replace' }] : []),
    ], action => {
      if (this.logs !== logs) return;
      if (action === 'pod') return this.chooseLogPod();
      if (action === 'container') return this.chooseLogContainer();
      if (action === 'add') return this.addLogPod();
      if (action === 'remove') return this.removeLogPod();
      if (action === 'replace') return this.chooseReplacementPod();
    });
  }

  async chooseLogContainer() {
    const logs = this.logs;
    if (!logs) return;
    const choose = async source => {
      const controller = this.logStreams.beginLogAction(logs);
      const pod = await this.cluster.backend(logs.profile).resource(logs.profile, source.pod, controller.signal, { fresh: true });
      if (controller.signal.aborted || this.logs !== logs || !logs.sources.includes(source)) return;
      this.pick(t('logs.chooseContainer'), pod.containers.map(container => ({ name: container, description: '', value: container })), container => {
        if (this.logs !== logs || !logs.sources.includes(source)) return;
        return this.logStreams.changeLogSources(logs.sources.map(item => item === source ? { pod, container, serviceTarget: source.serviceTarget } : item), { restart: true });
      });
    };
    if (logs.sources.length === 1) await choose(logs.sources[0]);
    else this.pick(t('logs.choosePod'), logs.sources.map(source => ({ name: source.pod.name, description: source.container, value: source })), choose);
  }

  resetLogHistory() {
    this.logViewport.clearSelection(false);
    this.logViewport.goEnd();
  }

  onLogViewChanged() {
    const logs = this.logs;
    if (!logs || this.closing) return;
    if (logs.wasFollowing && !this.logViewport.following) logs.pausedAt = logs.buffer.sequence;
    logs.wasFollowing = this.logViewport.following;
    this.updateLogMeta();
    this.updateActions();
  }

  flushLogs(force = false) {
    const logs = this.logs;
    if (!logs || this.closing || this.small || (!logs.dirty && !force)) return;
    logs.dirty = false;
    this.logViewport.emptyMessage = t('logs.empty');
    this.logViewport.setRecords(logs.buffer.matching());
    if (force) this.logViewport.draw();
    this.updateLogMeta();
  }

  updateLogMeta() {
    const logs = this.logs;
    if (!logs) return;
    const live = logs.sources.filter(source => source.status === 'live').length;
    const errors = logs.sources.filter(source => source.status === 'error').length;
    const retrying = logs.sources.filter(source => source.status === 'retrying');
    const opening = logs.sources.filter(source => source.status === 'opening').length;
    const ended = logs.sources.filter(source => source.status === 'ended').length;
    const seconds = retrying.length ? Math.max(0, Math.ceil((Math.min(...retrying.map(source => source.retryAt)) - Date.now()) / 1000)) : 0;
    const states = [];
    if (logs.sources.length > 1) {
      states.push(t('logs.partial', { live, total: logs.sources.length }));
      if (errors) states.push(t('logs.errorCount', { count: errors }));
      if (retrying.length) states.push(t('logs.retryCountdown', { count: retrying.length, seconds }));
      if (opening) states.push(t('logs.connectingCount', { count: opening }));
      if (ended) states.push(t('logs.endedCount', { count: ended }));
    } else {
      states.push(live ? t('logs.live') : errors ? t('logs.failed') : retrying.length ? t('logs.retrying', { seconds }) :
        opening || !logs.sources.length ? t('logs.connecting') : t('logs.closed'));
    }
    const connection = states.join(' · ');
    this.logConnection.content = connection;
    this.logConnection.fg = errors ? this.colors.error : retrying.length || opening || !logs.sources.length ? this.colors.warn :
      live ? this.colors.good : this.colors.muted;
    const following = this.logViewport.following;
    const unread = Math.max(0, logs.buffer.sequence - logs.pausedAt);
    const follow = [t(following ? 'logs.follow' : 'logs.reading')];
    if (!following) {
      if (unread) follow.push(t('logs.newRecords', { count: unread }));
      follow.push(t('logs.resumeHint'));
    }
    const followText = follow.join(' · ');
    this.logFollow.content = followText;
    this.logFollow.fg = following ? this.colors.muted : this.colors.accent;
    const stacked = stringWidth(connection) + stringWidth(followText) + 1 > this.renderer.width - 4;
    this.logStatus.flexDirection = stacked ? 'column' : 'row';
    this.logStatus.height = stacked ? 2 : 1;
    this.logStatus.gap = stacked ? 0 : 1;
    this.logConnection.width = stacked ? '100%' : 'auto';
    this.logConnection.flexGrow = stacked ? 0 : 1;
    this.logFollow.width = stacked ? '100%' : 'auto';
    this.logFollow.textAlign = stacked ? 'left' : 'right';
    this.logPanel.title = logs.sources.length === 1 ? t('logs.title', { pod: logs.sources[0].pod.name, container: logs.sources[0].container }) : t('logs.multiTitle', { count: logs.sources.length });
    const buffer = logs.buffer;
    const parts = [];
    if (this.logViewport.query) parts.push(t('logs.matches', { current: this.logViewport.matchIndex, count: this.logViewport.matchCount }));
    parts.push(t('logs.buffered', { count: buffer.records.length }));
    this.logMeta.content = parts.join(' · ');
    this.navigation.refresh();
  }

  focusSearch() {
    this.navigation.focus(this.filter);
  }

  clearLogSearch() {
    this.filter.value = '';
    this.logViewport.setQuery('');
    this.logViewport.focus();
    this.updateHeader();
  }

  findLogMatch(direction = 1) {
    if (!this.logs || !this.logViewport.query) { this.focusSearch(); return; }
    if (!this.logViewport.findMatch(direction)) this.setStatus(t('logs.noMatches'));
    else if (this.logViewport.currentMatch?.sourceOnly) this.setStatus(t('logs.sourceMatch'));
  }

  toggleLogFilter() {
    if (!this.logs) return;
    this.logViewport.toggleFilter();
    this.updateHeader();
  }

  followLogs() { if (this.logs) this.logViewport.goEnd(); }
  toggleFollow() { if (this.logs) this.logViewport.toggleFollow(); }
  toggleWrap() { if (this.logs) this.logViewport.setWrap(!this.logViewport.wrap); }

  handleLogPaste(event) {
    if (!this.logs || this.modal || this.renderer.currentFocusedRenderable instanceof InputRenderable || this.closing) return;
    event.preventDefault(); event.stopPropagation();
    const text = oneLine(new TextDecoder().decode(event.bytes)).slice(0, 160);
    this.focusSearch();
    this.filter.value = text;
    this.logViewport.setQuery(text);
  }

  async chooseLogPod() {
    const logs = this.logs;
    if (!logs) return;
    if (logs.target?.kind !== 'service') return this.chooseLogContainer();
    const controller = this.logStreams.beginLogAction(logs);
    const backend = this.cluster.backend(logs.profile);
    const service = await backend.resource(logs.profile, logs.target, controller.signal, { fresh: true });
    const pods = await backend.podsFor(logs.profile, service, controller.signal);
    if (controller.signal.aborted || this.logs !== logs || this.closing) return;
    if (!pods.length) throw new Error(t('logs.noPods'));
    this.pick(t('logs.choosePod'), [
      ...(pods.length <= 16 ? [{ name: t('logs.allPods', { count: pods.length }), description: '', value: 'all' }] : []),
      ...pods.map(pod => ({ name: pod.name, description: `${pod.ready} · ${pod.status}`, value: pod })),
    ], async choice => {
      if (this.logs !== logs) return;
      const request = this.logStreams.beginLogAction(logs);
      const selected = await Promise.all((choice === 'all' ? pods : [choice]).map(pod => backend.resource(logs.profile, pod, request.signal, { fresh: true })));
      if (request.signal.aborted || this.logs !== logs || this.closing) return;
      if (selected.some(pod => !pod.containers.length)) throw new Error(t('logs.noContainers'));
      return this.logStreams.changeLogSources(selected.map(pod => ({ pod, container: pod.defaultContainer ?? pod.containers[0], serviceTarget: logs.target })), { restart: true });
    });
  }

  removeLogPod() {
    const logs = this.logs;
    if (!logs || logs.sources.length <= 1) return;
    this.pick(t('logs.removePod'), logs.sources.map(source => ({ name: source.pod.name, description: source.container, value: source })),
      source => this.logs === logs && this.logStreams.changeLogSources(logs.sources.filter(item => item !== source)));
  }

  async closeLogs(invalidate = true) {
    if (invalidate) this.logGeneration++;
    const logs = this.logs;
    if (!logs) return;
    if (this.actionRequest === logs.actionRequest) logs.actionRequest?.abort();
    this.logs = null;
    this.logViewport.reset();
    this.renderer.clearSelection();
    if (!this.closing) {
      this.filter.value = this.savedFilter ?? '';
      this.logPanel.visible = false;
      this.body.visible = !this.small;
      this.resourceTable.renderTable();
      this.updateHeader();
      this.table.focus();
    }
    const closing = Promise.allSettled([...logs.sources.map(source => this.logStreams.stopLogSource(source)), this.exportJob?.cancel(), this.exportDone, ...this.logStreams.logClosures]);
    this.logStreams.logClosures.add(closing);
    await closing;
    this.logStreams.logClosures.delete(closing);
  }

  async copySelection() {
    const own = this.logs && !this.modal && this.logViewport.hasSelection();
    const text = own ? this.logViewport.getSelectedText() : this.renderer.getSelection()?.getSelectedText();
    if (!text) { this.setStatus(t('status.selectText')); return; }
    const result = await this.clipboard.writeText(text, { destination: 'best-available' });
    if (this.closing) return;
    this.setStatus(t(result.host.status === 'written' ? 'status.copied' : result.terminal.status === 'attempted' ? 'status.copyAttempted' : 'status.copyUnsupported'));
    if (own) this.logViewport.clearSelection();
    else this.renderer.clearSelection();
  }

  handleKey(key) {
    if (this.closing) return;
    const consume = () => { key.preventDefault(); key.stopPropagation(); };
    const shortcut = commandKey(key, !(this.renderer.currentFocusedRenderable instanceof InputRenderable));
    if (this.modal?.captureKey?.(key)) { consume(); return; }
    if (key.name === 'f10') {
      consume();
      if (this.small) void this.shutdown();
      else this.commands.execute(this.commands.quit);
      return;
    }
    if (key.ctrl && shortcut === 'c') {
      consume();
      if (this.renderer.hasSelection || this.logs && !this.modal && this.logViewport.hasSelection()) void this.perform(() => this.copySelection());
      else if (this.modal) { if (this.modal.busy) this.actionRequest?.abort(); else this.cancelModal(); }
      else if (this.logs) void this.perform(() => this.closeLogs());
      else this.requestQuit();
      return;
    }
    if (key.ctrl && key.name === 'insert' && this.logs && !this.modal && this.logViewport.hasSelection()) { consume(); void this.perform(() => this.copySelection()); return; }
    if (key.ctrl && shortcut === 'y') { consume(); void this.perform(() => this.copySelection()); return; }
    if (this.small) { if (shortcut === 'q') { consume(); void this.shutdown(); } return; }
    if (key.name === 'escape' && this.modal?.closeOnEscape) {
      consume();
      this.renderer.clearSelection();
      this.closeModal();
      return;
    }
    if (this.navigation.handleKey(key)) return;
    if (key.name === 'escape') {
      consume();
      if (this.modal?.exitConfirmation) { this.closeModal(); return; }
      if (this.cluster.request && !this.cluster.request.signal.aborted) {
        this.cluster.cancelRefresh();
      }
      if (this.modal?.busy) { this.actionRequest?.abort(); return; }
      this.actionRequest?.abort();
      if (this.renderer.hasSelection) this.renderer.clearSelection();
      else if (this.modal) this.cancelModal();
      else if (this.logs) {
        if (this.logViewport.hasSelection() && this.renderer.currentFocusedRenderable !== this.filter) this.logViewport.clearSelection();
        else if (this.renderer.currentFocusedRenderable === this.filter || this.logViewport.query) this.clearLogSearch();
        else void this.perform(() => this.closeLogs());
      } else if (this.renderer.currentFocusedRenderable === this.filter || this.filter.value) { this.filter.value = ''; this.table.focus(); }
      this.updateHeader();
      return;
    }
    if (key.name === 'tab') {
      consume();
      if (this.switching && !this.modal) return;
      this.navigation.cycle(key.shift);
      return;
    }
    if (this.modal) {
      if (this.modal.handleKey?.(key)) { consume(); return; }
      if (key.ctrl && key.name === 's' && this.modal.submit) { consume(); void this.perform(this.modal.submit); }
      return;
    }
    if (this.switching) { consume(); return; }
    const common = this.commands.commonActions().find(command => key.name === command.shortcut.toLowerCase());
    if (common) {
      consume();
      this.commands.execute(common);
      return;
    }
    if (key.ctrl && shortcut === 'f') { consume(); this.commands.execute(this.commands.search); return; }
    if (this.renderer.currentFocusedRenderable === this.filter) {
      if (this.logs && key.ctrl && shortcut === 's') { consume(); this.exportLogs(); }
      return;
    }
    if (key.ctrl || key.meta || key.option) return;
    if (['return', 'space'].includes(key.name) && [...this.tabBoxes, this.directoryButton, this.logFilterButton, ...this.resourceButtons, ...this.actionButtons, ...this.keyButtons].includes(this.renderer.currentFocusedRenderable)) return;
    const name = shortcut;
    if (name === '/') { consume(); this.commands.execute(this.commands.search); return; }
    if (name === 'y') { consume(); void this.perform(() => this.copySelection()); return; }
    if (!this.logs && ['1', '2', '3', '4'].includes(name)) { consume(); void this.switchTab(tabs[Number(name) - 1]); return; }
    if (!this.logs && clusterTabs.includes(this.tab) && ['p', 's'].includes(name)) {
      consume();
      void this.switchTab(name === 'p' ? 'pods' : 'services');
      return;
    }
    const command = this.commands.forKey(key, name);
    if (command) {
      consume();
      this.commands.execute(command);
      return;
    }
  }

  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.setStatus(t('status.stoppingApp'));
    this.closing = true;
    clearInterval(this.logTimer);
    clearInterval(this.clockTimer);
    clearImmediate(this.pendingUpdate);
    this.cluster.cancelPodDetails();
    this.cluster.request?.abort();
    this.actionRequest?.abort();
    this.logGeneration++;
    this.shutdownPromise = (async () => {
      await Promise.allSettled([this.forwards.close(), this.closeLogs(), this.privileged.close(), this.pool.close(), this.clipboard.dispose(), ...this.logStreams.logClosures]);
      try { await this.store.close(); }
      catch (error) { this.shutdownError = error; process.exitCode = 1; }
      for (const [signal, handler] of this.signalHandlers) process.off(signal, handler);
      this.renderer.destroy();
      await this.renderer.closed;
      if (this.fatal) {
        process.off('uncaughtException', this.fatal);
        process.off('unhandledRejection', this.fatal);
      }
      if (this.shutdownError) process.stderr.write(`kuberikon: ${this.shutdownError.message}\n`);
    })();
    return this.shutdownPromise;
  }

}

export async function startApp(options, version) {
  const store = await new SettingsStore().load();
  let renderer;
  let app;
  try {
    renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], screenMode: 'alternate-screen',
      useMouse: true, autoFocus: false, targetFps: 30, maxFps: 30, openConsoleOnError: false,
      backgroundColor: themes[options.theme].background });
    app = new KuberikonApp(renderer, options, version, store);
    const fatal = error => {
      process.exitCode = 1;
      void app.shutdown().finally(() => process.stderr.write(`kuberikon: ${error?.message ?? error}\n`));
    };
    app.fatal = fatal;
    process.on('uncaughtException', fatal);
    process.on('unhandledRejection', fatal);
    await app.perform(() => app.init());
  } catch (error) {
    if (app) await app.shutdown();
    else { renderer?.destroy(); if (renderer) await renderer.closed; await store.close(); }
    throw error;
  }
}
