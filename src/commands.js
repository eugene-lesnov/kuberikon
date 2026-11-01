import { showLogDetails } from './log-details.js';

function matchesShortcut(binding, key, name) {
  if (binding === 'Enter') return key.name === 'return';
  if (binding === 'Esc') return key.name === 'escape';
  if (binding === 'Space') return key.name === 'space';
  return binding.length === 1 ? binding === name : key.name === binding.toLowerCase();
}

export class AppCommands {
  constructor(app) {
    this.app = app;
    const details = { shortcut: 'Enter', aliases: ['i'], message: 'action.details', run: () => app.resourceTable.showDetails() };
    const control = { shortcut: 's', message: 'action.start', run: () => app.controlCurrent(), defer: true };
    const edit = { shortcut: 'e', message: 'action.edit', run: () => app.editCurrent(), defer: true };
    const remove = { shortcut: 'd', message: 'action.delete', run: () => app.deleteCurrent() };
    const logs = { shortcut: 'l', message: 'action.logs', run: () => app.viewLogs(), defer: true };
    const forward = { shortcut: 'f', message: 'action.forward', run: () => app.openForward(), defer: true };
    const showForward = { shortcut: 'g', message: 'action.showForward', run: () => app.showInForwards(), defer: true };
    const pin = { shortcut: 'u', message: 'action.pin', run: () => app.toggleFavorite(), defer: true };
    const refresh = { shortcut: 'r', message: 'action.refresh', run: () => app.cluster.refresh(), defer: true };
    const search = { shortcut: '/', message: 'action.find', run: () => app.focusSearch() };
    this.search = search;
    this.quit = { shortcut: 'F10', aliases: ['q'], message: 'action.quit', run: () => app.requestQuit() };
    this.views = {
      services: [details, logs, forward, showForward, pin, refresh],
      pods: [details, logs, forward, showForward, pin,
        { shortcut: 'm', message: 'action.services', run: () => app.findService(), defer: true }, refresh],
      favorites: [logs, forward,
        { ...pin, message: 'action.unpin' },
        { shortcut: '[', message: 'action.moveUp', run: () => app.moveFavorite(-1), defer: true },
        { shortcut: ']', message: 'action.moveDown', run: () => app.moveFavorite(1), defer: true }],
      forwards: [details, control, edit, remove, logs, pin,
        { shortcut: 't', message: 'action.group', run: () => app.groupForward() },
        { shortcut: 'a', message: 'action.active', run: () => {
          app.runningOnly = !app.runningOnly;
          app.resourceTable.renderTable();
          app.updateActions();
        } }, refresh],
      groups: [details, control, { shortcut: 'n', message: 'action.new', run: () => app.editGroup() }, edit, remove, refresh],
      logs: [
        { shortcut: 'Space', aliases: [' '],
          get message() { return app.logViewport.following ? 'action.pause' : 'action.follow'; },
          run: () => app.toggleFollow() },
        { shortcut: 'End', message: 'action.live', run: () => app.followLogs() }, search,
        { shortcut: 'Enter', aliases: ['i'], message: 'action.details', run: () => showLogDetails(app),
          keyEnabled: () => app.renderer.currentFocusedRenderable === app.logViewport },
        { shortcut: 'v', aliases: ['w'],
          get message() { return app.logViewport.wrap ? 'action.wrapOn' : 'action.wrapOff'; },
          run: () => app.toggleWrap() },
        { shortcut: 'p', message: 'action.sources', run: () => app.chooseLogSources() },
        { shortcut: 'r', message: 'action.reloadHistory', run: () => app.logStreams.reloadLogs(), defer: true },
        { shortcut: 'e', message: 'action.export', run: () => app.exportLogs() },
        { shortcut: 'Esc', aliases: ['q'], message: 'action.back', run: () => app.closeLogs(), defer: true },
      ],
    };
    this.common = [
      { shortcut: 'F2', message: 'action.profiles', run: () => app.openProfiles() },
      { ...search, shortcut: 'F3' },
      { shortcut: 'F4', message: 'action.namespace', run: () => app.chooseNamespace(), defer: true },
      { shortcut: 'F9', message: 'action.settings', run: () => app.settingsInfo() }, this.quit,
    ];
    this.logCommon = this.common.filter(command => !['F3', 'F4'].includes(command.shortcut));
    this.resourceKeys = [this.quit];
    this.logKeys = [
      { shortcut: 'a', run: () => app.addLogPod(), defer: true },
      { shortcut: 'd', run: () => app.removeLogPod() },
    ];
  }

  viewActions() {
    return this.views[this.app.logs ? 'logs' : this.app.tab];
  }

  commonActions() {
    if (this.app.logs) return this.logCommon;
    return this.common.filter(command => command.shortcut !== 'F4' || ['services', 'pods'].includes(this.app.tab));
  }

  forKey(key, name) {
    const matches = command => (matchesShortcut(command.shortcut, key, name) ||
      command.aliases?.some(binding => matchesShortcut(binding, key, name))) && (!command.keyEnabled || command.keyEnabled());
    const visible = this.viewActions().find(matches);
    if (visible) return visible;
    const extra = (this.app.logs ? this.logKeys : this.resourceKeys).find(matches);
    if (extra) return extra;
  }

  execute(command) {
    if (command.defer) void this.app.perform(command.run);
    else command.run();
  }
}
