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
    const current = () => app.resourceTable.current();
    const selected = () => Boolean(current());
    const connections = () => app.resourceTable.relatedForwards(current());
    const details = { shortcut: 'Enter', aliases: ['i'], message: 'action.details', when: selected, run: () => app.resourceTable.showDetails() };
    const openResource = { ...details, message: 'action.openResource' };
    const control = { shortcut: 'f', when: () => Boolean(current()?.forwardIds?.length),
      get message() { return current()?.forwardIds && app.forwards.isActive(app.templateGroup(current())) ? 'action.stopForward' : 'action.startForward'; },
      run: () => app.controlCurrent(), defer: true };
    const edit = { shortcut: 'e', message: 'action.edit', when: selected, run: () => app.editCurrent(), defer: true };
    const remove = { shortcut: 'd', message: 'action.delete', when: selected, run: () => app.deleteCurrent() };
    const logs = { shortcut: 'l', message: 'action.logs', when: selected, run: () => app.viewLogs(), defer: true };
    const forward = { shortcut: 'f', when: selected,
      get message() {
        const records = connections();
        return records.length > 1 ? 'action.chooseForward' : app.forwardAction(records[0]);
      },
      run: () => app.toggleForward(), defer: true };
    const pin = { shortcut: 'u', when: () => app.canToggleFavorite(current()),
      get message() { return app.isFavorite(current()) ? 'action.unpin' : 'action.pin'; },
      run: () => app.toggleFavorite(), defer: true };
    const refresh = { shortcut: 'r',
      get message() {
        const phase = app.cluster.currentLoad?.phase;
        return phase === 'loading' ? 'action.refreshing' : phase === 'error' ? 'action.retry' : 'action.refresh';
      },
      run: () => app.cluster.refresh(), defer: true };
    const search = { shortcut: '/', message: 'action.find', run: () => app.focusSearch() };
    this.search = search;
    this.quit = { shortcut: 'F10', aliases: ['q'], message: 'action.quit', run: () => app.requestQuit() };
    this.views = {
      services: [openResource, forward, logs, pin, refresh],
      pods: [openResource, forward, logs, pin,
        { shortcut: 'm', message: 'action.services', when: selected, run: () => app.findService(), defer: true }, refresh],
      favorites: [openResource, forward, logs, pin,
        { shortcut: '[', message: 'action.moveUp', when: () => selected() && current() !== app.visibleRows[0],
          run: () => app.moveSavedItem(-1), defer: true },
        { shortcut: ']', message: 'action.moveDown', when: () => selected() && current() !== app.visibleRows.at(-1),
          run: () => app.moveSavedItem(1), defer: true }],
      forwards: [details, { shortcut: 'f', aliases: ['s'], when: selected, get message() { return app.forwardAction(current()); },
        run: () => app.controlCurrent(), defer: true }, edit, remove, { ...logs, when: () => Boolean(current()?.profile) },
        { shortcut: 'c', message: 'action.copyAddress', when: selected, run: () => app.copyForward(), defer: true },
        { shortcut: 'o', message: 'action.openBrowser', when: () => current()?.status === 'running', run: () => app.openForwardBrowser() },
        { shortcut: 't', message: 'action.group', when: selected, run: () => app.groupForward() },
        { shortcut: 'h', get message() { return app.runningOnly ? 'action.stoppedHidden' : 'action.hideStopped'; },
          active: () => app.runningOnly, run: () => {
          app.runningOnly = !app.runningOnly;
          app.resourceTable.renderTable();
        } }],
      groups: [details, control, { shortcut: 'n', message: 'group.new', run: () => app.editGroup() }, edit, remove,
        { shortcut: '[', message: 'action.moveUp', when: () => selected() && current() !== app.visibleRows[0],
          run: () => app.moveSavedItem(-1), defer: true },
        { shortcut: ']', message: 'action.moveDown', when: () => selected() && current() !== app.visibleRows.at(-1),
          run: () => app.moveSavedItem(1), defer: true }],
      logs: [
        { shortcut: 'Space', aliases: [' '],
          get message() { return app.logViewport.following ? 'action.pause' : 'action.follow'; },
          run: () => app.toggleFollow() },
        { shortcut: 'End', message: 'action.live', run: () => app.followLogs() }, search,
        { shortcut: 'Enter', aliases: ['i'], message: 'action.details', run: () => showLogDetails(app),
          keyEnabled: () => app.renderer.currentFocusedRenderable === app.logViewport },
        { shortcut: 'v', aliases: ['w'],
          get message() { return app.logViewport.wrap ? 'action.wrapOn' : 'action.wrapOff'; },
          active: () => app.logViewport.wrap, run: () => app.toggleWrap() },
        { shortcut: 'p', message: 'action.sources', run: () => app.chooseLogSources() },
        { shortcut: 'r', message: 'action.reloadHistory', run: () => app.logStreams.reloadLogs(), defer: true },
        { shortcut: 'e', message: 'action.export', run: () => app.exportLogs() },
        { shortcut: 'Esc', aliases: ['q'], message: 'action.back', run: () => app.closeLogs(), defer: true },
      ],
    };
    this.common = [
      { shortcut: 'F2', message: 'action.profiles', run: () => app.openProfiles() },
      search,
      { shortcut: 'F4', message: 'action.namespace', run: () => app.chooseNamespace(), defer: true },
      { shortcut: 'F9', message: 'action.settings', run: () => app.settingsInfo() }, this.quit,
    ];
    this.logCommon = this.common.filter(command => !['/', 'F4'].includes(command.shortcut));
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
    const visible = this.viewActions().find(command => matches(command) && (!command.when || command.when()));
    if (visible) return visible;
    const extra = (this.app.logs ? this.logKeys : this.resourceKeys).find(matches);
    if (extra) return extra;
  }

  execute(command) {
    if (command.defer) void this.app.perform(command.run);
    else command.run();
  }
}
