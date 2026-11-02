import { ScrollBoxRenderable } from '@opentui/core';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { findExecutable } from './processes.js';
import { join } from 'node:path';
import { expandPath, discoverProfiles } from './kube.js';
import { validateForward, validNamespace, isProfileFile, favoriteKey } from './config.js';
import { LogExport } from './logs.js';
import { commandKey } from './controls.js';
import { oneLine, statusLabel } from './text.js';
import { t } from './i18n/index.js';
import { declaredForwardPorts, suggestLocalPort, suggestTemplatePort, validateTemplatePorts } from './ports.js';
import { Dialogs } from './dialogs.js';

export class ManagementDialogs extends Dialogs {
  openProfiles() {
    const profiles = this.profiles.filter(profile => isProfileFile(profile.file));
    const modal = this.showModal(t('profile.title'), { height: Math.min(this.renderer.height - 2, Math.max(12, Math.min(profiles.length, 10) + 9)) });
    const search = this.input({ value: '', placeholder: t('profile.search'), maxLength: 160 });
    modal.dialog.add(search);
    modal.search = search;
    const select = this.select({ flexGrow: 1, minHeight: 2, options: [] });
    modal.dialog.add(select);
    const empty = this.message(modal.dialog, '', { flexGrow: 1, minHeight: 2 });
    const details = this.message(modal.dialog, '', { height: 2, wrapMode: 'none', truncate: true });
    const updateDetails = () => {
      const profile = select.getSelectedOption()?.value;
      details.content = profile ? oneLine(profile.file) + (profile.context ? '\n' + t('profile.context', {
        context: oneLine(profile.context), namespace: oneLine(profile.namespace) }) : '') : '';
    };
    const refresh = () => {
      const previous = select.getSelectedOption()?.value;
      const query = search.value.toLowerCase();
      const matches = profiles.filter(profile => [profile.name, profile.file, profile.context, profile.namespace].join(' ').toLowerCase().includes(query));
      select.options = matches.map(profile => ({ name: `${profile.id && profile.id === this.profile?.id ? '● ' : '  '}${oneLine(profile.name)}`,
        description: '', value: profile }));
      select.visible = matches.length > 0;
      empty.visible = !matches.length;
      empty.content = t(profiles.length ? 'profile.noMatches' : 'profile.empty');
      select.setSelectedIndex(Math.max(0, matches.findIndex(profile => previous ? profile === previous : profile.id && profile.id === this.profile?.id)));
      updateDetails();
    };
    const connect = () => {
      const profile = select.getSelectedOption()?.value;
      if (!profile || this.modal !== modal) return;
      this.closeModal();
      return this.cluster.connect(profile);
    };
    select.on('selectionChanged', updateDetails);
    select.on('itemSelected', () => { void this.perform(connect); });
    search.on('input', refresh);
    const buttons = this.buttonRow(modal.dialog, { footer: true });
    const openFile = this.button(buttons, t('profile.open'), () => this.openProfileFile());
    modal.focusables = [search, select, openFile,
      this.button(buttons, t('dialog.cancel'), () => this.closeModal()),
      this.button(buttons, t('profile.connect'), connect, { primary: true, enabled: () => Boolean(select.getSelectedOption()) })];
    this.navigationHint(modal);
    modal.handleKey = key => {
      if (key.name === 'f9') { this.settingsInfo(); return true; }
      return false;
    };
    refresh();
    if (select.visible) select.focus();
    else openFile.focus();
  }

  openProfileFile() {
    this.form(t('profile.pathTitle'), [
      { key: 'file', label: t('profile.path'), value: '' },
      { key: 'name', label: t('profile.name'), value: '' },
    ], async values => {
      if (!values.file) throw new Error(t('error.profileFile'));
      await this.cluster.connect({ file: expandPath(values.file), name: values.name || undefined, mode: 'live' });
    }, { submitLabel: t('dialog.open') });
  }

  manageProfiles() {
    const profiles = this.store.data.profiles;
    this.pick(t('profile.manage'), profiles.length ? profiles.map(profile => ({ name: profile.name,
      description: `${profile.context} · ${profile.file}${isProfileFile(profile.file) ? '' : ` · ${t('profile.unsupportedFile')}`}`, value: profile })) : [{ name: t('profile.none'), description: '', value: null }], profile => {
      if (!profile) return;
      this.pick(profile.name, [
        { name: t('profile.edit'), description: '', value: 'edit' },
        { name: t('profile.delete'), description: '', value: 'delete' },
      ], action => action === 'edit' ? this.editProfile(profile) : this.deleteProfile(profile));
    });
  }

  editProfile(profile) {
    this.form(t('profile.edit'), [
      { key: 'name', label: t('profile.name'), value: profile.name },
      { key: 'file', label: t('profile.path'), value: profile.file },
      { key: 'namespace', label: t('namespace.name'), value: profile.namespace },
    ], async values => {
      if (!values.name) throw new Error(t('error.name'));
      if (values.namespace !== '*' && !validNamespace(values.namespace)) throw new Error(t('error.namespace'));
      const file = expandPath(values.file);
      const controller = this.beginAction();
      const resolved = await this.live.resolveProfile({ ...profile, ...values, file, context: file === profile.file ? profile.context : undefined }, controller.signal);
      if (this.closing) return;
      const selected = this.profile?.id === profile.id;
      if (selected) this.switching = true;
      try {
        await this.forwards.stopProfile(profile.id);
        await this.persist(data => { data.profiles = data.profiles.map(item => item.id === profile.id ? resolved : item); return data; });
        if (!this.closing && this.profile?.id === profile.id) {
          await this.closeLogs();
          this.profile = resolved;
          this.namespace = values.namespace;
          this.rows = [];
          await this.cluster.refresh();
        }
      } finally { if (selected) this.switching = false; }
    });
  }

  deleteProfile(profile) {
    const remove = async () => {
      const selected = this.profile?.id === profile.id;
      if (selected) this.switching = true;
      try {
        await this.forwards.stopProfile(profile.id);
        await this.persist(data => {
          data.profiles = data.profiles.filter(item => item.id !== profile.id);
          return data;
        });
        if (!this.closing && this.profile?.id === profile.id) {
          await this.cluster.disconnectProfile();
        }
      } finally { if (selected) this.switching = false; }
    };
    this.confirm(t('profile.delete'), t('profile.deleteText', { name: profile.name }), t('dialog.delete'), remove);
  }

  async toggleForward(item = this.resourceTable.current()) {
    if (!item || item.spec || item.forwardIds) return;
    if (this.resourceTable.relatedForwards(item).length) {
      return this.chooseResourceForward((record, start) => this.controlCurrent(record, start), item, record => t(this.forwardAction(record)));
    }
    return this.openForward(item);
  }

  forwardAction(record) {
    if (!record) return 'action.forwardPort';
    if (record.status === 'stopping') return 'status.stopping';
    if (record.want) return 'action.stopForward';
    return record.status === 'error' ? 'action.retryForward' : 'action.startForward';
  }

  async openForward(item) {
    if (!this.profile) { this.openProfiles(); return; }
    if (item.compact || item.favorite) {
      const origin = this.modal;
      const controller = this.beginAction();
      const favorite = item.favorite;
      const profile = favorite ? await this.cluster.backend().resolveProfile({ ...this.profile }, controller.signal) : this.profile;
      item = await this.cluster.backend(profile).resource(profile, favorite ? favorite.target : item, controller.signal, { fresh: Boolean(favorite) });
      if (controller.signal.aborted || this.closing || this.modal !== origin) return;
    }
    const ports = [...declaredForwardPorts(item).values()];
    if (ports.length > 1) {
      this.pick(t('forward.choosePort'), ports.map(port => ({ name: `${port.name ? port.name + ' · ' : ''}${port.port}/TCP`, value: port })),
        port => this.forwardForm(item, { port }), `${item.namespace}/${item.kind}/${item.name}`);
      return;
    }
    return this.forwardForm(item, { port: ports[0] });
  }

  sameForward(left, right) {
    return ['kind', 'name', 'namespace', 'localPort', 'remotePort', 'address'].every(key => left[key] === right[key]);
  }

  forwardKey(spec) {
    return JSON.stringify([spec.kind, spec.name, spec.namespace, spec.localPort, spec.remotePort, spec.address]);
  }

  templateGroup(group) {
    const configurations = this.forwards.configurations;
    const profileId = this.profile?.id;
    if (this.templateIndex?.configurations !== configurations || this.templateIndex.profileId !== profileId) {
      this.templateIndex = { configurations, profileId,
        sources: new Map(configurations.map(record => [record.id, record])),
        targets: new Map(configurations.filter(record => profileId && record.profileId === profileId)
          .map(record => [this.forwardKey(record.spec), record.id])) };
    }
    const { sources, targets } = this.templateIndex;
    return { ...group, sourceId: group.id, id: JSON.stringify([group.id, profileId]), forwardIds: [...new Set(group.forwardIds.map(id => {
      const source = sources.get(id);
      return source && targets.get(this.forwardKey(source.spec));
    }).filter(Boolean))] };
  }

  async startTemplate(group) {
    if (!this.profile) { this.openProfiles(); return; }
    const existing = this.templateGroup(group);
    validateTemplatePorts(group.forwardIds.map(id => this.templateIndex.sources.get(id)).filter(Boolean));
    if (existing.forwardIds.length === group.forwardIds.length) return this.forwards.startGroup(existing);
    const profileId = this.profile.id;
    let resolved;
    await this.persist(data => {
      const byId = new Map(data.forwards.map(record => [record.id, record]));
      const targets = new Map(data.forwards.filter(record => record.profileId === profileId)
        .map(record => [this.forwardKey(record.spec), record]));
      const sources = group.forwardIds.map(id => byId.get(id)).filter(Boolean);
      const forwardIds = sources.map(source => {
        const key = this.forwardKey(source.spec);
        let record = targets.get(key);
        if (!record) {
          record = { id: randomUUID(), profileId, spec: { ...source.spec } };
          data.forwards.push(record);
          targets.set(key, record);
        }
        return record.id;
      });
      resolved = { ...group, sourceId: group.id, id: JSON.stringify([group.id, profileId]), forwardIds: [...new Set(forwardIds)] };
      return data;
    });
    if (this.closing || this.profile?.id !== profileId) return;
    return this.forwards.startGroup(resolved);
  }

  async forwardForm(item, { port, record, onReturn } = {}) {
    const profile = record?.profileId ? this.profilesById.get(record.profileId) : this.profile;
    if (!profile && !record) { this.openProfiles(); return; }
    let values = { ...(record?.spec ?? { ...item, localPort: item.localPort ?? port?.port ?? 8080,
      remotePort: item.remotePort ?? (item.kind === 'service' && port?.name ? port.name : port?.port ?? ''), address: 'localhost' }) };
    if (!record) {
      const origin = this.modal;
      const controller = this.beginAction();
      const reserved = this.forwards.records.filter(entry => this.forwards.isActive(entry) || entry.profileId === profile.id &&
        entry.spec.kind === item.kind && entry.spec.namespace === item.namespace && entry.spec.name === item.name);
      values.localPort = await suggestLocalPort(values.localPort, values.address, reserved, controller.signal);
      if (controller.signal.aborted || this.closing || this.modal !== origin || this.profile?.id !== profile.id) return;
    }
    const show = (advanced = false) => {
      const modal = this.form(t(record ? 'forward.edit' : 'forward.title'), [
        { key: 'localPort', label: t('forward.localPort'), value: values.localPort },
        ...(!port || record || advanced ? [{ key: 'remotePort', label: t('forward.remotePort'), value: values.remotePort }] : []),
        ...(advanced ? [{ key: 'address', label: t('group.listenAddress'), value: values.address }] : []),
      ], async fields => {
        const configuration = { id: record?.id ?? randomUUID(), profileId: record ? record.profileId : profile.id,
          spec: validateForward({ ...values, ...fields }) };
        const duplicate = this.store.data.forwards.find(entry => entry.id !== configuration.id &&
          entry.profileId === configuration.profileId && this.sameForward(entry.spec, configuration.spec));
        if (duplicate && record) throw new Error(t('error.duplicateForward'));
        const saved = duplicate ?? configuration;
        if (record) await this.forwards.suspend(record);
        try {
          await this.persist(data => {
            if (!duplicate) data.forwards = [...data.forwards.filter(entry => entry.id !== saved.id), saved];
            return data;
          });
        } finally { if (record) this.forwards.resume(record); }
        if (this.closing) return;
        if (this.modal === modal) this.closeModal();
        if (!record) await this.forwards.start(saved);
        onReturn?.(saved);
        if (record) this.setStatus(t('forward.saved'));
        else {
          const result = this.forwards.records.find(entry => entry.id === saved.id);
          if (result?.status === 'error') this.setStatus(result.info, true);
        }
      }, { height: advanced ? 23 : record || !port ? 20 : 16,
        submitLabel: t(record ? 'dialog.save' : 'action.startForward'), onCancel: onReturn,
        description: `${oneLine(profile?.name ?? t('forward.profileMissing'))}\n${values.namespace}/${values.kind}/${values.name}${values.remotePort ? ':' + values.remotePort : ''}` });
      const advancedButton = this.button(modal.scroll, t(advanced ? 'group.less' : 'group.advanced'), () => {
        if (modal.busy) return;
        values = { ...values, ...Object.fromEntries([...modal.controls].map(([key, control]) => [key, control.value.trim()])) };
        show(!advanced);
      });
      modal.rows.set(advancedButton, advancedButton);
      modal.focusables.splice(modal.focusables.length - 2, 0, advancedButton);
      if (!record && !advanced && port) this.navigation.focus(modal.focusables.at(-1));
      else if (!values.remotePort) this.navigation.focus(modal.controls.get('remotePort'));
    };
    show();
  }

  forwardAddress(record) {
    const address = ['localhost', '0.0.0.0', '::'].includes(record.spec.address) ? 'localhost' : record.spec.address;
    return `${address.includes(':') ? '[' + address + ']' : address}:${record.spec.localPort}`;
  }

  async copyForward(record = this.resourceTable.current()) {
    if (!record?.spec) return;
    const result = await this.clipboard.writeText(this.forwardAddress(record), { destination: 'best-available' });
    if (!this.closing) this.setStatus(t(result.host.status === 'written' ? 'status.addressCopied' :
      result.terminal.status === 'attempted' ? 'status.copyAttempted' : 'status.copyUnsupported'));
  }

  openForwardBrowser(record = this.resourceTable.current(), onReturn) {
    if (record?.status !== 'running') return;
    this.pick(t('forward.browser'), ['http', 'https'].map(protocol => ({
      name: `${protocol}://${this.forwardAddress(record)}`, description: '', value: protocol,
    })), async protocol => {
      onReturn?.();
      if (this.forwards.records.find(entry => entry.id === record.id)?.status !== 'running') return;
      const url = `${protocol}://${this.forwardAddress(record)}`;
      await new Promise((resolve, reject) => {
        execFile(findExecutable('xdg-open'), [url], { timeout: 10000, maxBuffer: 65536 }, error => error ? reject(error) : resolve());
      });
      if (!this.closing) this.setStatus(t('forward.browserOpened'));
    });
    this.modal.cancel = onReturn;
  }

  deleteForward(record) {
    this.confirm(t('forward.delete'), t('forward.deleteText', { name: `${record.spec.kind}/${record.spec.name}` }), t('dialog.delete'), async () => {
      await this.forwards.suspend(record);
      try {
        await this.persist(data => {
          data.forwards = data.forwards.filter(item => item.id !== record.id);
          data.groups = data.groups.map(group => ({ ...group, forwardIds: group.forwardIds.filter(id => id !== record.id) }));
          return data;
        });
      } finally { this.forwards.resume(record); }
    });
  }

  favoriteEntry(item = this.resourceTable.current()) {
    if (item?.favorite?.type === 'resource') return item.favorite;
    const target = item?.spec ?? item;
    if (['service', 'pod'].includes(target?.kind)) {
      return { type: 'resource', target: { kind: target.kind, name: target.name, namespace: target.namespace } };
    }
    return null;
  }

  isFavorite(item = this.resourceTable.current()) {
    const favorite = this.favoriteEntry(item);
    if (!favorite) return false;
    const key = favoriteKey(favorite);
    return this.store.data.favorites.some(entry => favoriteKey(entry) === key);
  }

  canToggleFavorite(item = this.resourceTable.current()) {
    const favorite = this.favoriteEntry(item);
    return Boolean(favorite && (favorite.target.kind === 'service' || this.isFavorite(item)));
  }

  async toggleFavorite(item = this.resourceTable.current()) {
    const favorite = this.favoriteEntry(item);
    if (!favorite || !this.canToggleFavorite(item)) return;
    const key = favoriteKey(favorite);
    await this.persist(data => {
      const index = data.favorites.findIndex(entry => favoriteKey(entry) === key);
      if (index >= 0) data.favorites.splice(index, 1);
      else if (favorite.target.kind === 'service') data.favorites.push(favorite);
      return data;
    });
  }

  chooseResourceForward(onChoose, item, label) {
    const records = this.resourceTable.relatedForwards(item);
    if (!records.length) return;
    if (records.length === 1) return onChoose(records[0], !records[0].want);
    this.pick(t('favorite.chooseForward'), records.map(record => ({
      name: `${record.spec.remotePort} → ${this.forwardAddress(record)}`,
      description: [statusLabel(record.status), label?.(record)].filter(Boolean).join(' · '), value: { id: record.id, start: !record.want },
    })), ({ id, start }) => {
      const record = this.forwards.records.find(record => record.id === id);
      if (record) return onChoose(record, start);
    }, `${item.namespace}/${item.kind}/${item.name}`);
  }

  async moveSavedItem(direction, item = this.resourceTable.current()) {
    const tab = this.tab;
    if (!['favorites', 'groups'].includes(tab) || !item) return;
    const key = this.resourceTable.rowId(item);
    const entryKey = tab === 'favorites' ? favoriteKey : entry => entry.id;
    const index = this.visibleRows.findIndex(row => this.resourceTable.rowId(row) === key);
    if (index < 0 || !this.visibleRows[index + direction]) return;
    const visibleIds = new Set(this.visibleRows.map(row => this.resourceTable.rowId(row)));
    await this.persist(data => {
      const entries = data[tab];
      const keys = entries.map(entryKey);
      const visible = keys.filter(id => visibleIds.has(id));
      const position = visible.indexOf(key);
      const neighborId = visible[position + direction];
      if (position < 0 || !neighborId) return data;
      const from = keys.indexOf(key);
      const to = keys.indexOf(neighborId);
      const [entry] = entries.splice(from, 1);
      entries.splice(to, 0, entry);
      return data;
    });
    if (this.tab === tab && !this.logs && !this.closing && this.selected[tab] === key) {
      this.resourceTable.selectRow(this.visibleRows.findIndex(row => this.resourceTable.rowId(row) === key));
    }
  }

  groupForward(record = this.resourceTable.current()) {
    if (!record?.spec) { this.setStatus(t('status.startHint')); return; }
    this.pick(t('group.choose'), [
      { name: t('group.new'), description: '', value: null },
      ...this.store.data.groups.map(group => ({ name: `${group.forwardIds.includes(record.id) ? '[x]' : '[ ]'} ${group.name}`,
        description: t('group.memberCount', { count: group.forwardIds.length }), value: group })),
    ], group => this.editGroup(group, record.id), `${record.spec.namespace}/${record.spec.name}`);
  }

  editGroup(group, forwardId, state = {}) {
    const draft = state.draft ?? (group ? structuredClone(group) : { id: randomUUID(), name: '', forwardIds: [], autostart: false });
    state = { ...state, draft, pending: state.pending ?? [] };
    if (forwardId && !draft.forwardIds.includes(forwardId)) draft.forwardIds.push(forwardId);
    const records = new Map([...this.forwards.records, ...state.pending]
      .map(record => [record.id, record]));
    const members = () => draft.forwardIds.map(id => records.get(id)).filter(Boolean);
    const modal = this.showModal(t(group ? 'group.edit' : 'group.new'), {
      width: 88, height: Math.min(this.renderer.height - 2, Math.max(20, Math.min(28, members().length * 2 + 16))),
    });
    this.label(modal.dialog, t('group.name'));
    const name = this.input({ value: draft.name, maxLength: 128 });
    modal.dialog.add(name);
    this.text(modal.dialog, '', { height: 1, flexShrink: 0 });
    this.label(modal.dialog, t('group.forwards'));
    const select = this.select({ flexGrow: 1, minHeight: 2, options: [], showDescription: true });
    modal.dialog.add(select);
    const empty = this.message(modal.dialog, t('group.empty'), { flexGrow: 1, minHeight: 2 });
    const actions = this.buttonRow(modal.dialog);
    const addMember = () => {
      if (modal.busy) return;
      draft.name = name.value;
      state.selectedForwardId = select.getSelectedOption()?.value;
      this.addGroupForward(state, record => {
        if (record && !draft.forwardIds.includes(record.id)) {
          draft.forwardIds.push(record.id);
          if (!this.store.data.forwards.some(item => item.id === record.id)) state.pending.push(record);
        }
        if (record) state.selectedForwardId = record.id;
        this.editGroup(group, undefined, { ...state, focusForwards: true });
      });
    };
    const add = this.button(actions, t('group.addForward'), addMember, { shortcut: 'a' });
    const removeMember = () => {
      if (modal.busy) return;
      const id = select.getSelectedOption()?.value;
      draft.forwardIds = draft.forwardIds.filter(key => key !== id);
      state.pending = state.pending.filter(record => record.id !== id);
      refresh();
      if (!select.visible) add.focus();
    };
    const remove = this.button(actions, t('group.remove'), removeMember, { shortcut: 'r' });
    const refresh = () => {
      const selectedId = select.getSelectedOption()?.value ?? state.selectedForwardId;
      const entries = members();
      select.options = entries.map(record => ({ name: `${oneLine(record.spec.name)}   ${record.spec.localPort} → ${record.spec.remotePort}`,
        description: `${record.spec.namespace} · ${record.spec.kind}`, value: record.id }));
      select.setSelectedIndex(Math.max(0, entries.findIndex(record => record.id === selectedId)));
      select.visible = entries.length > 0;
      empty.visible = !entries.length;
      remove.visible = entries.length > 0;
    };
    const toggleAuto = () => {
      if (modal.busy) return;
      draft.autostart = !draft.autostart;
      auto.actionActive = draft.autostart;
      this.setActionLabel(auto, `${draft.autostart ? '[x]' : '[ ]'} ${t('group.autostart')}`);
    };
    const auto = this.button(modal.dialog, `${draft.autostart ? '[x]' : '[ ]'} ${t('group.autostart')}`, toggleAuto, { active: draft.autostart });
    const error = this.message(modal.dialog, '', { height: 2, error: true });
    const save = async () => {
      if (modal.busy || this.modal !== modal || this.closing) return;
      modal.busy = true;
      this.refreshButtons();
      try {
        const groupName = name.value.trim();
        if (!groupName || groupName.length > 128) throw new Error(t('error.name'));
        await this.persist(data => {
          if (data.groups.some(item => item.id !== draft.id && item.name.toLowerCase() === groupName.toLowerCase())) throw new Error(t('error.duplicateGroup'));
          const ids = new Map();
          const memberIds = new Set(draft.forwardIds);
          for (const record of state.pending.filter(item => memberIds.has(item.id))) {
            const existing = data.forwards.find(item =>
              item.profileId === record.profileId && this.sameForward(item.spec, record.spec));
            ids.set(record.id, existing?.id ?? record.id);
            if (!existing) data.forwards.push(record);
          }
          const saved = { id: draft.id, name: groupName, autostart: draft.autostart,
            forwardIds: [...new Set(draft.forwardIds.map(id => ids.get(id) ?? id))] };
          const records = new Map(data.forwards.map(record => [record.id, record]));
          validateTemplatePorts(saved.forwardIds.map(id => records.get(id)));
          const index = data.groups.findIndex(item => item.id === draft.id);
          const previous = data.groups[index];
          if (index < 0) data.groups.push(saved);
          else data.groups[index] = saved;
          return this.removeUnusedTemplateForwards(data, previous?.forwardIds ?? []);
        });
        this.forwards.cancelGroup(draft.id);
        if (this.closing || this.modal !== modal) return;
        this.closeModal();
        this.tab = 'groups'; this.filter.value = ''; this.queries.groups = ''; this.selected.groups = draft.id;
        this.resourceTable.renderTable(); this.updateHeader();
      } catch (failure) { if (this.modal === modal) error.content = oneLine(failure.message); }
      finally { modal.busy = false; this.refreshButtons(); }
    };
    const buttons = this.buttonRow(modal.dialog, { footer: true });
    modal.submit = save;
    modal.focusables = [name, select, add, remove, auto,
      this.button(buttons, t('dialog.cancel'), () => this.closeModal()), this.button(buttons, t('dialog.save'), save, { primary: true })];
    this.navigationHint(modal);
    modal.handleKey = key => {
      if (modal.busy) return true;
      if (key.ctrl || key.meta || key.option) return false;
      const shortcut = commandKey(key);
      if (shortcut === 'a') {
        void this.perform(addMember);
        return true;
      }
      if (this.renderer.currentFocusedRenderable === select && (shortcut === 'r' || ['delete', 'backspace'].includes(key.name))) {
        removeMember();
        return true;
      }
      return false;
    };
    refresh();
    if (!group && !state.focusForwards) name.focus();
    else if (select.visible) select.focus();
    else add.focus();
  }

  addGroupForward(state, onReturn) {
    const profile = this.profile;
    const scope = state.scope ?? { namespace: '*', kind: 'service' };
    state.scope = scope;
    let mode = profile ? 'cluster' : 'saved';
    let rows = [];
    let loadedKey;
    let query = '';
    const back = () => onReturn();
    const browse = () => {
      const modal = this.showModal(t('group.addTitle'), { width: 96, height: Math.min(29, this.renderer.height - 2) });
      modal.cancel = back;
      let request;
      modal.onClose = () => request?.abort();
      const saved = this.forwards.records.filter(record => !state.draft.forwardIds.includes(record.id));
      const controls = [];
      if (mode === 'cluster' && profile) {
        const bar = this.buttonRow(modal.dialog);
        const chooseNamespace = () => {
          if (modal.busy) return;
          this.form(t('namespace.title'), [{ key: 'namespace', label: t('group.resourceNamespace'), value: scope.namespace }], values => {
            if (values.namespace !== '*' && !validNamespace(values.namespace)) throw new Error(t('error.namespace'));
            scope.namespace = values.namespace; query = ''; browse();
          }, { onCancel: browse, submitLabel: t('dialog.apply'), cancelLabel: t('group.back'), height: 12 });
        };
        controls.push(this.button(bar, t('group.namespaceFilter', {
          name: scope.namespace === '*' ? t('namespace.all') : scope.namespace,
        }), chooseNamespace, { shortcut: 'F4' }));
        modal.handleKey = key => {
          if (key.name !== 'f4') return false;
          chooseNamespace();
          return true;
        };
        this.message(modal.dialog, `${oneLine(profile.name)}\nContext: ${oneLine(profile.context)}`, {
          height: 2, truncate: true, wrapMode: 'none' });
      }
      const sources = this.buttonRow(modal.dialog);
      if (mode === 'cluster') {
        controls.push(this.button(sources, t('view.services'), () => {
          if (!modal.busy) { scope.kind = 'service'; query = ''; browse(); }
        }, { active: scope.kind === 'service' }), this.button(sources, t('view.pods'), () => {
          if (!modal.busy) { scope.kind = 'pod'; query = ''; browse(); }
        }, { active: scope.kind === 'pod' }));
      } else this.label(sources, t('group.savedForwards'));
      if (mode === 'cluster' ? saved.length : profile) controls.push(this.button(sources,
        t(mode === 'cluster' ? 'group.useSaved' : 'group.browseCluster'), () => {
          if (!modal.busy) { mode = mode === 'cluster' ? 'saved' : 'cluster'; query = ''; browse(); }
        }));
      const search = this.input({ value: query, maxLength: 160,
        placeholder: t(mode === 'cluster' ? 'group.resourceSearch' : 'group.savedSearch') });
      modal.dialog.add(search);
      modal.search = search;
      const select = this.select({ flexGrow: 1, minHeight: 2, options: [], showDescription: mode === 'saved' });
      modal.dialog.add(select);
      const empty = this.message(modal.dialog, '', { flexGrow: 1, minHeight: 2 });
      const error = this.message(modal.dialog, '', { height: 2, error: true });
      let loading = false;
      let loadError = false;
      let next;
      const refresh = () => {
        const previous = select.getSelectedOption()?.value?.id;
        const terms = search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
        const matching = (mode === 'cluster' ? rows : saved).filter(item => terms.every(term =>
          [item.namespace, item.name, item.spec?.namespace, item.spec?.name, item.spec?.localPort, item.spec?.remotePort].join(' ').toLowerCase().includes(term)));
        select.options = loading ? [] : matching.map(item => mode === 'cluster' ? {
          name: `${item.namespace}/${item.name}`, description: '', value: item,
        } : { name: `${oneLine(item.spec.name)}   ${item.spec.localPort} → ${item.spec.remotePort}`,
          description: `${item.spec.namespace} · ${item.spec.kind}`, value: item });
        select.setSelectedIndex(Math.max(0, select.options.findIndex(option => option.value.id === previous)));
        select.visible = select.options.length > 0;
        empty.visible = !select.visible;
        empty.content = loading ? t('group.loading') : loadError ? '' :
          t(!profile && !saved.length ? 'group.connectFirst' : mode === 'saved' ? 'group.noSaved' : 'group.noResourcesMatch');
        if (next) next.visible = select.visible;
      };
      const choose = async () => {
        let item = select.getSelectedOption()?.value;
        if (!item || loading || modal.busy || this.modal !== modal) return;
        if (mode === 'saved') { onReturn(this.store.data.forwards.find(record => record.id === item.id)); return; }
        modal.busy = true;
        this.refreshButtons();
        try {
          request = this.beginAction();
          if (item.compact) item = await this.cluster.backend(profile).resource(profile, item, request.signal);
          if (request.signal.aborted || this.modal !== modal || this.closing) return;
          this.configureGroupForward(item, profile, state, onReturn, browse);
        } catch (failure) { if (this.modal === modal && !this.closing) error.content = oneLine(failure.message); }
        finally { modal.busy = false; this.refreshButtons(); }
      };
      search.on('input', () => { query = search.value; refresh(); });
      select.on('itemSelected', () => { void choose(); });
      const buttons = this.buttonRow(modal.dialog, { footer: true });
      const retry = this.button(buttons, t('group.retry'), () => { loadedKey = undefined; browse(); });
      retry.visible = false;
      const backButton = this.button(buttons, t('group.back'), () => { if (!modal.busy) this.cancelModal(); });
      next = this.button(buttons, t(mode === 'cluster' ? 'group.next' : 'group.add'), choose, { primary: true });
      modal.focusables = [...controls, search, select, retry,
        backButton, next];
      this.navigationHint(modal);
      refresh();
      modal.focusables[0].focus();
      if (mode === 'cluster' && profile) {
        const key = JSON.stringify([profile.id, scope.namespace, scope.kind]);
        if (loadedKey === key) return;
        loading = true; refresh();
        request = this.beginAction();
        const signal = request.signal;
        void this.cluster.backend(profile).list(profile, scope.namespace, scope.kind, signal).then(result => {
          if (signal.aborted || this.modal !== modal || this.closing) return;
          rows = result; loadedKey = key; loading = false; refresh();
        }).catch(failure => {
          if (signal.aborted || this.modal !== modal || this.closing) return;
          rows = []; loading = false; loadError = true; error.content = oneLine(failure.message); refresh();
          retry.visible = true;
        });
      }
    };
    browse();
  }

  configureGroupForward(item, profile, state, onAdd, onBack) {
    const portOptions = item.ports.map(port => ({ name: `${port.name || port.port} · ${port.port}/TCP`,
      value: item.kind === 'service' && port.name ? port.name : String(port.port) }));
    const memberIds = new Set(state.draft?.forwardIds ?? state.pending.map(record => record.id));
    const reserved = [...this.store.data.forwards, ...state.pending].filter(record => memberIds.has(record.id));
    let suggestedLocalPort = suggestTemplatePort(item.ports[0]?.port ?? 8080, 'localhost', reserved);
    let values = { localPort: suggestedLocalPort, remotePort: portOptions[0]?.value ?? '8080', address: 'localhost' };
    const show = (advanced = false) => {
      const modal = this.form(t('group.configureForward'), [
        { key: 'remotePort', label: t('forward.remotePort'), value: values.remotePort, ...(portOptions.length ? { options: portOptions } : {}) },
        { key: 'localPort', label: t('forward.localPort'), value: values.localPort },
        ...(advanced ? [
          { key: 'address', label: t('group.listenAddress'), value: values.address },
        ] : []),
      ], fields => {
        const spec = validateForward({ ...values, ...fields, kind: item.kind, namespace: item.namespace, name: item.name });
        validateTemplatePorts([...reserved, { spec }]);
        const existing = [...this.store.data.forwards, ...state.pending].find(record =>
          !record.profileId && this.sameForward(record.spec, spec));
        onAdd(existing ?? { id: randomUUID(), profileId: null, spec });
      }, { onCancel: onBack, submitLabel: t('group.add'), cancelLabel: t('group.back'),
        height: advanced ? 23 : 20,
        description: `${oneLine(profile.name)} · ${oneLine(profile.context)}\n${item.namespace}/${item.kind}/${item.name}` });
      if (portOptions.length) modal.controls.get('remotePort').on('selectionChanged', () => {
        const selected = modal.controls.get('remotePort').getSelectedIndex();
        const address = modal.controls.get('address')?.value.trim() ?? values.address;
        const port = suggestTemplatePort(item.ports[selected].port, address, reserved);
        const local = modal.controls.get('localPort');
        if (local.value === String(suggestedLocalPort)) local.value = String(port);
        suggestedLocalPort = port;
      });
      const advancedButton = this.button(modal.scroll, t(advanced ? 'group.less' : 'group.advanced'), () => {
        if (modal.busy) return;
        values = { ...values, ...Object.fromEntries([...modal.controls].map(([key, control]) => {
          const choice = key === 'remotePort' && portOptions.length > 0;
          return [key, choice ? control.getSelectedOption().value : control.value.trim()];
        })) };
        show(!advanced);
      });
      modal.rows.set(advancedButton, advancedButton);
      modal.focusables.splice(modal.focusables.length - 2, 0, advancedButton);
    };
    show();
  }

  deleteGroup(group) {
    this.confirm(t('group.delete'), t('group.deleteText', { name: group.name }), t('dialog.delete'), async () => {
      this.forwards.cancelGroup(group.id);
      await this.persist(data => {
        const removed = data.groups.find(item => item.id === group.id);
        data.groups = data.groups.filter(item => item.id !== group.id);
        return this.removeUnusedTemplateForwards(data, removed?.forwardIds ?? []);
      });
    });
  }

  removeUnusedTemplateForwards(data, forwardIds) {
    const candidates = new Set(forwardIds);
    const referenced = new Set(data.groups.flatMap(group => group.forwardIds));
    data.forwards = data.forwards.filter(record => record.profileId !== null || !candidates.has(record.id) || referenced.has(record.id));
    return data;
  }

  settingsInfo() {
    this.pick(t('settings.title'), [
      { name: t('settings.folder'), description: this.profilesDirectory || t('settings.notSet'), value: 'paths' },
      { name: t('profile.manage'), description: '', value: 'profiles' },
      { name: t('settings.exportFolder'), description: this.store.data.logExportDirectory || t('settings.exportDefault'), value: 'export' },
      { name: t('settings.recovery'), description: '', value: 'recovery' },
    ], action => {
      if (action === 'paths') return this.editProfilesDirectory();
      if (action === 'profiles') return this.manageProfiles();
      if (action === 'export') return this.editExportDirectory();
      if (action === 'recovery') return this.recoveryInfo();
    });
  }

  recoveryInfo() {
    const info = [t('settings.location', { file: this.store.file }), t('settings.state', { file: this.store.stateFile }),
      t('settings.directoryInfo', { directory: this.profilesDirectory || t('settings.notSet') }),
      t(this.store.readOnly || this.store.damaged ? 'settings.readOnly' : 'settings.writable'), ...this.store.notices].join('\n');
    this.pick(t('settings.recovery'), [
      { name: t('dialog.close'), description: '', value: 'close' },
      ...(this.store.backup && !this.store.readOnly ? [{ name: t('settings.restore'), description: '', value: 'restore' }] : []),
    ], action => {
      if (action === 'restore') this.confirm(t('settings.restore'), t('settings.restoreText'), t('settings.restore'), async () => {
        await this.store.restoreBackup();
        const notice = await this.reloadPreferences();
        this.setStatus(notice ?? t('settings.restored'), Boolean(notice)); this.resourceTable.renderTable();
      });
    }, info);
  }

  get profilesDirectory() { return this.options['profiles-dir'] ?? this.store.data.profilesDirectory; }

  async reloadPreferences() {
    const directory = this.profilesDirectory;
    let profiles = [];
    let notice;
    try { if (directory) profiles = await discoverProfiles(directory); }
    catch (error) { notice = error.message; }
    this.discovered = profiles;
    this.directoryError = notice;
    this.syncStore();
    this.updateHeader();
    return notice;
  }

  editProfilesDirectory({ initial = false } = {}) {
    this.form(t('settings.folder'), [
      { key: 'directory', label: t('settings.directory'), value: this.store.data.profilesDirectory },
    ], async values => {
      const directory = values.directory ? expandPath(values.directory) : '';
      if (initial && !directory) throw new Error(t('error.profilesDirectory'));
      const discovered = this.options['profiles-dir'] ?? directory;
      const profiles = discovered ? await discoverProfiles(discovered) : [];
      await this.persist(data => ({ ...data, profilesDirectory: directory }));
      if (this.closing) return;
      this.discovered = profiles;
      this.directoryError = null;
      this.syncStore();
      this.updateHeader();
      this.setStatus(t('settings.pathsSaved', { count: profiles.length }));
      this.openProfiles();
    }, { hint: t(initial ? 'settings.setupHint' : 'settings.pathsHint'),
      submitLabel: t(initial ? 'dialog.continue' : 'dialog.save') });
  }

  async findService(item = this.resourceTable.current()) {
    if (!item || item.kind !== 'pod') return;
    const controller = this.beginAction();
    const services = await this.cluster.backend().servicesFor(this.profile, item, controller.signal);
    if (controller.signal.aborted || this.closing) return;
    if (!services.length) throw new Error(t('error.noService'));
    if (services.length === 1) return this.resourceTable.showDetails(services[0]);
    this.pick(t('forward.chooseService'), services.map(service => ({ name: service.name, description: service.ports.map(port => port.port).join(', '), value: service })), service => this.resourceTable.showDetails(service));
  }

  editExportDirectory() {
    this.form(t('settings.exportFolder'), [
      { key: 'directory', label: t('settings.exportFolder'), value: this.store.data.logExportDirectory },
    ], async values => {
      const directory = values.directory ? expandPath(values.directory) : '';
      await this.persist(data => ({ ...data, logExportDirectory: directory }));
      if (!this.closing) this.setStatus(t('settings.exportSaved', { directory: directory || process.cwd() }));
    }, { hint: t('settings.exportHint', { directory: process.cwd() }) });
  }

  exportFile(logs, kind) {
    const stamp = new Date();
    const pad = value => String(value).padStart(2, '0');
    const time = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}-${String(stamp.getMilliseconds()).padStart(3, '0')}`;
    const source = logs.sources.length === 1 ? `${logs.sources[0].pod.name}_${logs.sources[0].container}` : `pods-${logs.sources.length}`;
    const filename = source.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 160);
    return join(this.store.data.logExportDirectory || process.cwd(), `${filename}_${time}${kind === 'all' ? '_all' : ''}.log`);
  }

  exportLogs() {
    if (!this.logs) return;
    if (this.exportJob) {
      this.confirm(t('logs.export'), t('logs.cancelExportText'), t('logs.cancelExport'), () => this.exportJob?.cancel());
      return;
    }
    const logs = this.logs;
    const buffered = logs.buffer.matching(this.logViewport.query).map(record => ({ display: record.display }));
    const modal = this.showModal(t('logs.export'), { width: 96, height: Math.min(24, this.renderer.height - 2) });
    this.label(modal.dialog, t('logs.exportMode'));
    const mode = this.select({ height: 2,
      options: [
        { name: t('logs.exportBuffer'), description: '', value: 'buffer' },
        { name: t('logs.exportAll'), description: '', value: 'all' },
      ] });
    modal.dialog.add(mode);
    const description = this.message(modal.dialog, '', { height: 4 });
    this.label(modal.dialog, t('logs.exportPath'));
    const files = { buffer: this.exportFile(logs, 'buffer'), all: this.exportFile(logs, 'all') };
    let suggested = files.buffer;
    const path = this.input({ value: suggested, maxLength: 4096 });
    modal.dialog.add(path);
    const preview = new ScrollBoxRenderable(this.renderer, { flexGrow: 1, minHeight: 2, scrollY: true, scrollX: false });
    modal.dialog.add(preview);
    const destination = this.text(preview, '', { width: '100%', flexShrink: 0, wrapMode: 'word', selectable: true });
    const error = this.message(modal.dialog, '', { height: 2, error: true });
    const updatePath = () => {
      error.content = '';
      const value = path.value.trim();
      destination.content = value ? expandPath(value) : '';
    };
    const updateMode = () => {
      const kind = mode.getSelectedOption()?.value ?? 'buffer';
      description.content = t(kind === 'buffer' ? 'logs.exportBufferHint' : 'logs.exportAllHint', { count: buffered.length });
      if (path.value === suggested) path.value = files[kind];
      suggested = files[kind];
      updatePath();
    };
    mode.on('selectionChanged', updateMode);
    mode.on('itemSelected', () => path.focus());
    path.on('input', updatePath);
    const submit = () => {
      if (this.modal !== modal || this.logs !== logs || this.exportJob || this.closing) return;
      try {
        const records = mode.getSelectedOption()?.value === 'buffer' ? buffered : undefined;
        if (records && !records.length) throw new Error(t('logs.exportEmpty'));
        const value = path.value.trim();
        if (!value) throw new Error(t('error.exportPath'));
        const job = new LogExport({ backend: this.cluster.backend(logs.profile), profile: { ...logs.profile },
          sources: logs.sources.map(source => ({ ...source })), file: expandPath(value), records });
        this.exportJob = job;
        this.closeModal();
        this.setStatus(t('logs.exporting', { file: job.file }));
        this.exportDone = job.run().then(lines => this.setStatus(t('logs.exported', { count: lines, file: job.file })))
          .catch(failure => this.setStatus(failure.message, true)).finally(() => { if (this.exportJob === job) this.exportJob = null; });
      } catch (failure) { error.content = oneLine(failure.message); }
    };
    const buttons = this.buttonRow(modal.dialog, { footer: true });
    modal.submit = submit;
    modal.focusables = [mode, path, preview, this.button(buttons, t('dialog.cancel'), () => this.closeModal()),
      this.button(buttons, t('logs.exportAction'), submit, { primary: true })];
    this.navigationHint(modal);
    updateMode();
    mode.focus();
  }
}
