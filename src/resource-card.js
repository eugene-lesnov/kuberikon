import { ScrollBoxRenderable } from '@opentui/core';
import { commandKey } from './controls.js';
import { t } from './i18n/index.js';
import { declaredForwardPorts } from './ports.js';
import { clean, oneLine, statusLabel } from './text.js';

function portRows(resource, records) {
  const declared = declaredForwardPorts(resource);
  const byTarget = new Map([...declared.values()].map(port => [String(port.port), port]));
  for (const [target, port] of declared) byTarget.set(target, port);

  const mapped = new Set();
  const rows = records.map(record => {
    const port = byTarget.get(record.spec.remotePort);
    if (port) mapped.add(port);
    return { key: `forward:${record.id}`, port, record };
  });
  for (const [target, port] of declared) {
    if (!mapped.has(port)) rows.push({ key: `port:${target}`, port });
  }
  if (resource && !rows.length) rows.push({ key: 'manual' });
  return rows;
}

export async function showResourceCard(app, item, selectedKey) {
  if (!app.profile) { app.openProfiles(); return; }
  const profile = app.profile;
  const originTab = app.tab;
  const request = new AbortController();
  const modal = app.showModal(`${item.kind}/${oneLine(item.name)}`, { width: 96, height: Math.min(31, app.renderer.height - 2) });
  modal.onClose = () => request.abort();
  const scroll = new ScrollBoxRenderable(app.renderer, { flexGrow: 1, minHeight: 2, scrollY: true, scrollX: false });
  modal.dialog.add(scroll);
  const scope = `${oneLine(profile.name)} · ${oneLine(profile.context)}\n${item.namespace}`;
  const info = app.message(scroll, `${scope}\n${t('resource.loading')}`);
  app.label(modal.dialog, t('resource.ports'));
  const ports = app.select({ height: 4, options: [], activateOnClick: false });
  modal.dialog.add(ports);
  const feedback = app.message(modal.dialog, '', { height: 2 });
  const actions = app.buttonRow(modal.dialog, { height: 2 });
  const footer = app.buttonRow(modal.dialog, { footer: true });
  let resource = item.favorite || item.compact ? undefined : item;
  let rows = [];
  let actionError = '';
  const current = () => rows[ports.getSelectedIndex()];
  const returnToResource = saved => {
    if (app.closing || app.modal || app.logs || app.tab !== originTab || app.profile?.id !== profile.id) return;
    const key = saved ? `forward:${saved.id}` : selectedKey;
    void app.perform(() => showResourceCard(app, resource ?? item, key));
  };
  const shortcuts = new Map();
  const action = (parent, shortcut, label, run, options = {}) => {
    const button = app.button(parent, t(label), run, { ...options, shortcut });
    shortcuts.set(shortcut, { button, run });
    return button;
  };
  const activate = async () => {
    const row = current();
    if (!row || row.record?.status === 'stopping' || modal.busy || app.modal !== modal) return;
    modal.busy = true;
    actionError = '';
    app.refreshButtons();
    try {
      if (row.record) await app.controlCurrent(row.record);
      else await app.forwardForm(resource, { port: row.port, onReturn: returnToResource });
    } catch (error) {
      if (error.name !== 'AbortError') actionError = error.message;
    } finally {
      modal.busy = false;
      if (app.modal === modal) modal.refresh();
      else returnToResource();
    }
  };
  const primary = action(actions, 'f', 'action.forwardPort', activate, { primary: true,
    enabled: () => Boolean(current()) && current().record?.status !== 'stopping' });
  primary.minWidth = 18;
  const another = action(actions, 'n', 'action.addLocalPort', () => {
    const row = current();
    return app.forwardForm(row.record.spec, { port: row.port, onReturn: returnToResource });
  }, { enabled: () => Boolean(current()?.record) });
  const edit = action(actions, 'e', 'action.edit', () => {
    const record = current().record;
    return app.forwardForm(record.spec, { record, onReturn: returnToResource });
  }, { enabled: () => Boolean(current()?.record) });
  const copy = action(actions, 'c', 'action.copyAddress', () => app.copyForward(current().record), { enabled: () => Boolean(current()?.record) });
  const browser = action(actions, 'o', 'action.openBrowser', () => app.openForwardBrowser(current().record, returnToResource),
    { enabled: () => current()?.record?.status === 'running' });
  const logs = action(footer, 'l', 'action.logs', () => {
    app.closeModal();
    return app.viewLogs(resource ?? item);
  });
  const pin = action(footer, 'u', 'action.pin', () => app.toggleFavorite(item));
  const close = app.button(footer, t('dialog.close'), () => app.closeModal());

  const updateActions = () => {
    const row = current();
    if (row) selectedKey = row.key;
    const record = row?.record;
    app.setActionLabel(primary, t(app.forwardAction(record)));
    pin.visible = app.canToggleFavorite(item);
    if (pin.visible) app.setActionLabel(pin, t(app.isFavorite(item) ? 'action.unpin' : 'action.pin'));
    feedback.content = clean(actionError || record?.info);
    feedback.fg = actionError || record?.status === 'error' ? app.colors.error : app.colors.muted;
    const focused = app.renderer.currentFocusedRenderable;
    if (modal.focusables.includes(focused) && !focused.visible) app.navigation.focus(rows.length ? ports : scroll);
    app.refreshButtons();
  };
  modal.refresh = () => {
    if (app.closing || request.signal.aborted) return;
    const previous = selectedKey;
    rows = portRows(resource, app.resourceTable.relatedForwards(item));
    const options = rows.map(({ key, port, record }) => {
      const remote = port ? `${port.port}/TCP${port.name ? ' · ' + oneLine(port.name) : ''}` : record?.spec.remotePort;
      const name = record ? `${remote} → ${app.forwardAddress(record)} · ${statusLabel(record.status)}` : remote ?? t('resource.manualPort');
      return { name, description: '', value: key };
    });
    if (ports.options.length !== options.length || options.some((option, index) =>
      option.name !== ports.options[index].name || option.value !== ports.options[index].value)) {
      ports.options = options;
      if (options.length) ports.setSelectedIndex(Math.max(0, options.findIndex(option => option.value === previous)));
    }
    updateActions();
  };
  modal.focusables = [scroll, ports, primary, another, edit, copy, browser, logs, pin, close];
  ports.on('selectionChanged', updateActions);
  ports.on('itemSelected', () => { void app.perform(activate); });
  modal.handleKey = key => {
    if (key.ctrl || key.meta || key.option) return false;
    const binding = shortcuts.get(commandKey(key));
    if (!binding?.button.visible || !binding.button.canActivate()) return false;
    void app.perform(binding.run);
    return true;
  };
  app.navigationHint(modal);
  modal.refresh();
  (rows.length ? ports : scroll).focus();

  const isOpen = () => !app.closing && !request.signal.aborted;
  const backend = app.cluster.backend(profile);
  try {
    resource ??= await backend.resource(profile, item.favorite?.target ?? item, request.signal, { fresh: Boolean(item.favorite) });
  } catch (error) {
    if (isOpen()) info.content = `${scope}\n${clean(error.message)}`;
    return;
  }
  if (!isOpen()) return;
  modal.refresh();
  if (app.renderer.currentFocusedRenderable === scroll) ports.focus();
  const description = `${scope} · ${oneLine(resource.status)}`;
  if (resource.kind === 'pod') {
    info.content = [description,
      t('details.ready', { ready: resource.ready, count: resource.restarts }),
      t('details.node', { name: resource.node || '—' }),
      t('details.ip', { address: resource.ips?.join(', ') || resource.ip || '—' }),
      t('details.containers', { names: resource.containers.join(', ') }),
    ].join('\n');
    return;
  }
  const podSection = `${description}\n${t('resource.pods')}\n`;
  info.content = podSection + t('resource.loadingPods');
  try {
    const pods = await backend.podsFor(profile, resource, request.signal);
    if (isOpen()) info.content = podSection + (pods.map(pod =>
      `${oneLine(pod.name)} · ${oneLine(pod.ready)} · ${oneLine(pod.status)}`).join('\n') || t('logs.noPods'));
  } catch (error) {
    if (isOpen()) info.content = podSection + clean(error.message);
  }
}
