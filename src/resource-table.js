import { MouseButton, ScrollBoxRenderable, StyledText, fg } from '@opentui/core';
import { cell, clean, oneLine, statusLabel, hostLabel, age, fitColumns } from './text.js';
import { t } from './i18n/index.js';
import { favoriteKey } from './config.js';

export class ResourceTable {
  constructor(app) {
    this.app = app;
  }

  columns(rows = this.app.visibleRows) {
    const app = this.app;
    const width = app.table.viewport.width || app.renderer.width - (app.sidebar.visible ? app.sidebar.width + 5 : 4);
    const favoriteKeys = new Set(app.store.data.favorites.map(favoriteKey));
    const favoriteColumn = [t('column.favorite'), 1,
      item => favoriteKeys.has(favoriteKey(app.favoriteEntry(item))) ? '★' : '', 0];
    let definitions;
    if (app.tab === 'groups') definitions = [
      [t('column.name'), 16, item => item.name, 1],
      [t('column.members'), 7, item => item.forwardIds.length, 0],
      [t('column.autostart'), 9, item => t(item.autostart ? 'group.on' : 'group.off'), 0],
      [t('column.status'), 16, item => item.status, 2],
    ];
    else if (app.tab === 'favorites') definitions = [
      [t('column.service'), 18, item => item.name, 1],
      [t('column.namespace'), 10, item => item.namespace, 2],
    ];
    else if (app.tab === 'forwards') definitions = [
      favoriteColumn,
      [t('column.target'), 18, item => `${item.spec.kind}/${item.spec.name}`, 1],
      [t('column.namespace'), 10, item => item.spec.namespace, 2],
      [t('column.local'), 17, item => `${hostLabel(item.spec.address)}:${item.spec.localPort}`, 0],
      [t('column.status'), 10, item => statusLabel(item.status), 0],
    ];
    else if (app.tab === 'services') definitions = [
      favoriteColumn,
      [t('column.name'), 18, item => item.name, 1],
      [t('column.namespace'), 10, item => item.namespace, 2],
      [t('column.ports'), 16, item => item.ports.map(port => `${port.name ? port.name + ':' : ''}${port.port}`).join(', ') || '—', 3],
      [t('column.forwards'), 14, item => this.relatedForwards(item).map(record => `${record.spec.localPort} ${statusLabel(record.status)}`).join(', ') || '—', 4],
    ];
    else definitions = [
      favoriteColumn,
      [t('column.name'), 18, item => item.name, 1],
      [t('column.namespace'), 10, item => item.namespace, 2],
      [t('column.ready'), 5, item => item.ready, 0],
      [t('column.status'), 12, item => item.status, 0],
      [t('column.restarts'), 8, item => item.restarts, 0],
      [t('column.age'), 5, item => item.createdAt ? age(item.createdAt) : item.ageText ?? '—', 0],
    ];
    return fitColumns(definitions, rows, width);
  }

  groupRows() {
    const app = this.app;
    const records = new Map(app.forwards.records.map(record => [record.id, record]));
    return app.store.data.groups.map(group => {
      const members = group.forwardIds.map(id => records.get(id));
      const running = members.filter(record => record?.status === 'running').length;
      const errors = members.filter(record => record?.status === 'error').length;
      const changing = members.some(record => ['starting', 'retrying', 'stopping'].includes(record?.status));
      let statusColor = running ? app.colors.good : app.colors.muted;
      if (changing || running > 0 && running < members.length) statusColor = app.colors.warn;
      if (errors) statusColor = app.colors.error;
      return { ...group, status: t('group.summary', { running, total: members.length, errors }), statusColor };
    });
  }

  favoriteRow(favorite) {
    return { ...favorite.target, id: favoriteKey(favorite), favorite };
  }

  filteredRows() {
    const app = this.app;
    let source = app.rows;
    if (app.tab === 'favorites') source = app.store.data.favorites.filter(favorite => favorite.target.kind === 'service')
      .map(favorite => this.favoriteRow(favorite));
    else if (app.tab === 'forwards') source = app.forwards.records.filter(record => !app.runningOnly || record.want);
    else if (app.tab === 'groups') source = this.groupRows();
    const terms = app.filter.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return source;
    return source.filter(item => {
      const spec = item.spec ?? item;
      const text = (app.tab === 'favorites' ? [item.name, item.namespace] :
        [spec.name, spec.namespace, item.status, spec.localPort, spec.remotePort, spec.address]).join(' ').toLowerCase();
      return terms.every(term => text.includes(term));
    });
  }

  renderTable() {
    const app = this.app;
    if (app.closing) return;
    const filtered = this.filteredRows();
    const nextRows = filtered.slice(0, 500);
    app.listPanel.title = t('list.title', { name: t(`view.${app.tab}`) + (app.tab === 'forwards' && app.runningOnly ? t('list.activeOnly') : ''), count: filtered.length });
    const columns = this.columns(nextRows);
    const header = columns.map(([name, width]) => cell(name, width)).join(' ');
    const reuse = nextRows.length > 0 && this.tableTab === app.tab && this.tableHeading === header &&
      nextRows.length === app.visibleRows.length && nextRows.every((item, index) => this.rowId(item) === this.rowId(app.visibleRows[index])) && this.tableLimited === (filtered.length > 500);
    app.visibleRows = nextRows;
    app.tableHeader.content = header;
    this.tableHeading = header;
    if (!reuse) {
      const scrollTop = this.tableTab === app.tab ? app.table.scrollTop : 0;
      app.clear(app.table);
      app.rowViews = app.visibleRows.map((item, index) => {
        const row = app.box(app.table, { height: 1, flexShrink: 0, width: '100%',
          onMouseDown: event => { if (event.button === MouseButton.LEFT && !app.modal) { this.selectRow(index); app.table.focus(); } } });
        const label = app.text(row, '', { height: 1, width: '100%', wrapMode: 'none', truncate: true });
        return { row, label };
      });
      const phase = app.cluster.currentLoad?.phase;
      if (!app.visibleRows.length && !['loading', 'error', 'cancelled'].includes(phase)) {
        const message = !app.profile && ['services', 'pods'].includes(app.tab) ? 'status.noProfile' :
          !app.filter.value.trim() && app.tab === 'groups' ? 'list.noGroups' :
          app.tab === 'favorites' ? (app.filter.value.trim() ? 'list.noFavoriteMatches' : 'list.noFavorites') :
          !app.filter.value.trim() && app.tab === 'forwards' ? 'list.noForwards' :
          !app.filter.value.trim() && phase === 'success' ? 'list.noResources' : 'list.empty';
        app.message(app.table, t(message), { paddingY: 1 });
      }
      if (filtered.length > 500) app.message(app.table, t('list.limit'), { fg: app.colors.warn });
      app.table.scrollTo(scrollTop);
      this.tableTab = app.tab;
      this.tableLimited = filtered.length > 500;
    }
    this.updateRowLabels(columns);
    const previous = app.visibleRows.findIndex(item => this.rowId(item) === app.selected[app.tab]);
    this.selectRow(previous >= 0 ? previous : 0, false);
  }

  updateRowLabels(columns = this.columns()) {
    const app = this.app;
    const statusColors = {
      running: app.colors.good, stopped: app.colors.muted, error: app.colors.error,
      starting: app.colors.warn, retrying: app.colors.warn, stopping: app.colors.warn,
    };
    const header = columns.map(([name, width]) => cell(name, width)).join(' ');
    if (this.tableHeading !== header) {
      app.tableHeader.content = header;
      this.tableHeading = header;
    }
    app.rowViews.forEach((view, index) => {
      const item = app.visibleRows[index];
      const cells = columns.map(([, width, get]) => cell(get(item), width));
      const content = cells.join(' ');
      const statusColor = app.tab === 'groups' ? item.statusColor :
        app.tab === 'forwards' ? statusColors[item.status] ?? app.colors.text : null;
      if (view.content !== content || view.statusColor !== statusColor) {
        view.label.content = statusColor ? new StyledText([
          fg(app.colors.text)(cells.slice(0, -1).join(' ') + ' '),
          fg(statusColor)(cells.at(-1)),
        ]) : content;
        view.content = content;
        view.statusColor = statusColor;
      }
    });
  }

  selectRow(index, scroll = true) {
    const app = this.app;
    const selected = app.visibleRows[Math.max(0, Math.min(index, app.visibleRows.length - 1))];
    app.selected[app.tab] = this.rowId(selected);
    this.paintSelection();
    if (scroll && selected) app.table.scrollChildIntoView(app.rowViews[app.visibleRows.indexOf(selected)].row);
    this.updateDetails();
    app.updateActions();
    app.navigation.refresh();
  }

  paintSelection() {
    const app = this.app;
    app.rowViews.forEach(({ row, label }, rowIndex) => {
      const chosen = this.rowId(app.visibleRows[rowIndex]) === app.selected[app.tab];
      row.backgroundColor = chosen ? app.table.focused ? app.colors.selected : app.colors.input : app.colors.background;
      const status = app.visibleRows[rowIndex]?.status;
      label.fg = ['favorites', 'forwards', 'groups'].includes(app.tab) || chosen ? app.colors.text : /error|CrashLoop|Failed|OOMKilled|BackOff|Evicted/i.test(status ?? '') ? app.colors.error : /Pending|Init:|Terminating|Unknown/i.test(status ?? '') ? app.colors.warn : app.colors.text;
    });
  }

  rowId(item) { return item?.favorite ? favoriteKey(item.favorite) : item?.id; }

  current() { return this.app.visibleRows.find(item => this.rowId(item) === this.app.selected[this.app.tab]); }

  relatedForwards(item) {
    const app = this.app;
    if (!item || item.spec || item.forwardIds) return [];
    if (!this.relatedIndex) {
      this.relatedIndex = new Map();
      for (const record of app.forwards.records) {
        const key = JSON.stringify([record.spec.namespace, record.spec.kind, record.spec.name]);
        const matches = this.relatedIndex.get(key) ?? [];
        matches.push(record);
        this.relatedIndex.set(key, matches);
      }
    }
    const matches = (kind, name) => this.relatedIndex.get(JSON.stringify([item.namespace, kind, name])) ?? [];
    const services = !item.favorite && app.profile && item.kind === 'pod' && app.podDetail?.key === app.cluster.backend().resourceKey(app.profile, item) ? app.podDetail.services ?? [] : [];
    return [...matches(item.kind, item.name), ...services.flatMap(service => matches('service', service.name))];
  }

  describe(item) {
    const app = this.app;
    if (!item) return t('details.empty');
    if (item.forwardIds) {
      const members = new Map(app.forwards.records.map(record => [record.id, record]));
      return [item.name, '', t('details.profile', { name: app.profile?.name ?? t('app.noProfile') }),
        t(item.autostart ? 'group.autoOn' : 'group.autoOff'), '', ...item.forwardIds.map(id => {
        const record = members.get(id);
        return `${record.spec.namespace}/${record.spec.name}\n${record.spec.localPort} → ${record.spec.remotePort} · ${statusLabel(record.status)}${record.info ? '\n' + clean(record.info) : ''}`;
      })].join('\n');
    }
    const detail = item.compact && app.profile && app.podDetail?.key === app.cluster.backend().resourceKey(app.profile, item) ? app.podDetail : null;
    if (detail?.value) item = { ...item, ...detail.value, status: item.status, ready: item.ready, restarts: item.restarts };
    const spec = item.spec ?? item;
    const lines = [t('details.resource', spec), '', t('details.namespace', { name: spec.namespace }),
      t('details.profile', { name: (item.profile ?? app.profile)?.name ?? t('app.noProfile') }), t('details.context', { name: (item.profile ?? app.profile)?.context ?? '—' })];
    if (item.spec) lines.push('', t('details.local', { address: hostLabel(spec.address), port: spec.localPort }),
      t('details.remote', { port: spec.remotePort }), t('details.status', { status: statusLabel(item.status) }),
      '', clean(item.info), '', t('details.journal'), ...item.journal.slice(-8).map(clean));
    else if (item.favorite) lines.push('', t('details.favorite'));
    else {
      lines.push('', t('details.status', { status: item.status }));
      if (!item.compact) lines.push(t('details.ports', { ports: item.ports.map(port => `${port.name ? port.name + ':' : ''}${port.port}`).join(', ') || '—' }));
      if (item.kind === 'pod') lines.push(t('details.ready', { ready: item.ready, count: item.restarts }),
        t('details.age', { age: item.createdAt ? age(item.createdAt) : item.ageText ?? '—' }),
        ...(item.compact ? ['', detail?.error ? t('details.failed', { reason: oneLine(detail.error) }) : t('details.loading')] :
          [t('details.created', { time: item.createdAt ?? '—' }), t('details.node', { name: item.node || '—' }),
            t('details.ip', { address: item.ips?.join(', ') || item.ip || '—' }), t('details.containers', { names: item.containers.join(', ') })]));
      const related = this.relatedForwards(item);
      if (related.length) lines.push('', t('details.forwards'), ...related.map(record =>
        `${hostLabel(record.spec.address)}:${record.spec.localPort} → ${record.spec.kind}/${record.spec.name}:${record.spec.remotePort}\n${statusLabel(record.status)}`));
      if (item.kind === 'pod' && related.some(record => record.spec.kind === 'service')) lines.push(t('details.serviceTarget'));
    }
    return lines.join('\n');
  }

  updateDetails() {
    const app = this.app;
    if (app.closing || app.renderer.hasSelection) return;
    if (!app.modal) app.cluster.schedulePodDetails(this.current());
    const content = this.describe(this.current());
    if (this.detailsContent !== content) { app.detailText.content = content; this.detailsContent = content; }
  }

  showDetails() {
    const app = this.app;
    const item = this.current();
    if (!item) return;
    const modal = app.showModal(t('details.title'), { width: 86, height: Math.min(25, app.renderer.height - 2) });
    const scroll = new ScrollBoxRenderable(app.renderer, { flexGrow: 1, scrollY: true, scrollX: false });
    modal.dialog.add(scroll);
    const text = app.text(scroll, this.describe(item), { width: '100%', selectable: true, wrapMode: 'word', flexShrink: 0 });
    let previous = this.describe(item);
    modal.refresh = () => {
      if (item.compact) app.cluster.schedulePodDetails(item, true);
      const current = item.spec ? app.forwards.records.find(record => record.id === item.id) : item;
      const content = this.describe(current);
      if (previous !== content) { text.content = content; previous = content; }
    };
    const buttons = app.buttonRow(modal.dialog, { footer: true });
    const close = app.button(buttons, t('dialog.close'), () => app.closeModal());
    modal.focusables = [scroll, close];
    app.navigationHint(modal);
    if (item.compact) app.cluster.schedulePodDetails(item, true);
    scroll.focus();
  }
}
