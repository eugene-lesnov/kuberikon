import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestRenderer } from '@opentui/core/testing';
import { emptySettings, validateSettings } from '../src/config.js';
import { ForwardManager } from '../src/forwards.js';
import { ManagementDialogs } from '../src/management.js';
import { KuberikonApp } from '../src/ui.js';

const profiles = ['dev', 'stage'].map(id => ({ id, name: id, mode: 'live', file: `/tmp/${id}.kuber`, context: id, namespace: 'default' }));
const spec = { kind: 'service', name: 'api', namespace: 'default', localPort: 18080, remotePort: 'http', address: 'localhost' };
const resource = { id: 'service:default/api', kind: 'service', name: 'api', namespace: 'default', status: 'ClusterIP',
  ports: [{ name: 'http', port: 8080 }], selector: { app: 'api' } };

function settings(forwards = [], groups = []) {
  return validateSettings({ ...emptySettings(), profiles, forwards, groups });
}

function managerHarness(configurations, resolveProfile = async profile => profile) {
  const calls = [];
  const backend = {
    prepareForward: async () => ({}),
    forward: (profile, spec, callbacks) => {
      calls.push({ profile, spec });
      queueMicrotask(() => callbacks.onLine(`Forwarding from 127.0.0.1:${spec.localPort} -> 8080`, false));
      return { stop: async () => callbacks.onClose({ code: 0 }) };
    },
  };
  const manager = new ForwardManager({ profile: record => profiles.find(profile => profile.id === record.profileId),
    resolveProfile, backend: () => backend });
  manager.replace(configurations);
  return { manager, calls };
}

test('current settings retain connection ownership and portable template presets', () => {
  const data = settings([{ id: 'connection', profileId: 'dev', spec }, { id: 'preset', profileId: null, spec }],
    [{ id: 'template', name: 'Backend', autostart: false, forwardIds: ['preset'] }]);
  assert.equal(data.forwards[0].profileId, 'dev');
  assert.equal(data.forwards[1].profileId, null);
  assert.deepEqual(validateSettings(JSON.parse(JSON.stringify(data))), data);
  assert.throws(() => settings([{ id: 'missing-owner', spec }]));
});

test('stopped and running connections keep their own profile regardless of the viewed cluster', async t => {
  const { manager, calls } = managerHarness([
    { id: 'dev-api', profileId: 'dev', spec },
    { id: 'stage-api', profileId: 'stage', spec: { ...spec, localPort: 18081 } },
  ]);
  t.after(() => manager.close());
  await manager.start({ id: 'dev-api' });
  await manager.start({ id: 'stage-api' });
  assert.deepEqual(calls.map(call => call.profile.context), ['dev', 'stage']);
  assert.deepEqual(manager.records.map(record => record.status), ['running', 'running']);
  await manager.stopProfile('dev');
  assert.deepEqual(manager.records.map(record => [record.profile.id, record.status]), [['dev', 'stopped'], ['stage', 'running']]);
  await manager.start({ id: 'dev-api' });
  assert.equal(calls.at(-1).profile.context, 'dev');
});

test('missing profiles fail without redirecting a connection to another cluster', async t => {
  const { manager, calls } = managerHarness([{ id: 'gone', profileId: 'deleted', spec }]);
  t.after(() => manager.close());
  await manager.start({ id: 'gone' });
  assert.equal(manager.records[0].status, 'error');
  assert.equal(manager.records[0].profile, undefined);
  assert.match(manager.records[0].info, /profile no longer exists/);
  assert.equal(calls.length, 0);
});

test('stopping a profile cancels a pending template without launching its remaining connections', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { manager, calls } = managerHarness([
    { id: 'first', profileId: 'dev', spec },
    { id: 'second', profileId: 'dev', spec: { ...spec, name: 'db' } },
  ], async profile => { await pending; return profile; });
  t.after(() => manager.close());
  const starting = manager.startGroup({ id: 'template', forwardIds: ['first', 'second'] });
  const stopping = manager.stopProfile('dev');
  release();
  await Promise.all([starting, stopping]);
  assert.equal(calls.length, 0);
  assert.equal(manager.groups.size, 0);
  assert.equal(manager.records[1].status, 'stopped');
});

test('portable templates reuse profile connections and never retarget existing ones', async () => {
  const source = { id: 'preset', profileId: null, spec };
  const group = { id: 'template', name: 'Backend', autostart: false, forwardIds: [source.id] };
  const app = new ManagementDialogs();
  app.profile = profiles[0];
  app.store = { data: settings([source], [group]) };
  let configurations = app.store.data.forwards;
  const starts = [];
  app.forwards = { get configurations() { return configurations; }, startGroup: async group => starts.push(group) };
  app.persist = async transform => {
    app.store.data = validateSettings(transform(structuredClone(app.store.data)));
    configurations = app.store.data.forwards;
  };
  await app.startTemplate(group);
  const devId = starts.at(-1).forwardIds[0];
  await app.startTemplate(group);
  assert.equal(starts.at(-1).forwardIds[0], devId);
  assert.equal(configurations.length, 2);
  app.profile = profiles[1];
  await app.startTemplate(group);
  const stageId = starts.at(-1).forwardIds[0];
  assert.notEqual(stageId, devId);
  assert.notEqual(starts.at(-1).id, starts[0].id);
  assert.equal(configurations.find(record => record.id === devId).profileId, 'dev');
  assert.equal(configurations.find(record => record.id === stageId).profileId, 'stage');
  assert.equal(configurations.find(record => record.id === source.id).profileId, null);
  app.profile = profiles[0];
  assert.deepEqual(app.templateGroup(group).forwardIds, [devId]);
});

test('local addresses use valid IPv6 URLs and loopback for wildcard listeners', () => {
  const app = new ManagementDialogs();
  assert.equal(app.forwardAddress({ spec }), 'localhost:18080');
  assert.equal(app.forwardAddress({ spec: { ...spec, address: '::1' } }), '[::1]:18080');
  assert.equal(app.forwardAddress({ spec: { ...spec, address: '0.0.0.0' } }), 'localhost:18080');
});

async function uiHarness(t, width, height, forwards = [
  { id: 'dev-api', profileId: 'dev', spec }, { id: 'stage-api', profileId: 'stage', spec: { ...spec, localPort: 18081 } },
]) {
  const setup = await createTestRenderer({ width, height, useMouse: true, kittyKeyboard: true, exitOnCtrlC: false, exitSignals: [] });
  const store = { data: settings(forwards), state: {}, notices: [],
    saveState: async () => {}, close: async () => {},
    update: async transform => { store.data = validateSettings(transform(structuredClone(store.data))); return store.data; } };
  const app = new KuberikonApp(setup.renderer, { theme: 'dark' }, '0.1.1', store);
  t.after(() => app.shutdown());
  app.profile = profiles[0];
  app.live.resource = async () => resource;
  app.live.resolveProfile = async profile => ({ ...profile });
  app.live.podsFor = async () => [{ name: 'api-123', ready: '1/1', status: 'Running' }];
  app.live.list = async () => [resource];
  app.live.prepareForward = async () => ({});
  app.live.forward = (profile, spec, callbacks) => {
    queueMicrotask(() => callbacks.onLine(`Forwarding from 127.0.0.1:${spec.localPort} -> 8080`, false));
    return { stop: async () => callbacks.onClose({ code: 0 }) };
  };
  app.rows = [resource];
  app.resize();
  app.table.focus();
  await setup.renderOnce();
  return { ...setup, app };
}

test('switching the viewed profile preserves running forwards and the global overview keeps their owners', async t => {
  const { app, mockInput, renderOnce, captureCharFrame } = await uiHarness(t, 120, 32);
  await app.forwards.start({ id: 'dev-api' });
  await app.cluster.connect(profiles[1]);
  assert.equal(app.profile.id, 'stage');
  assert.equal(app.forwards.records.find(record => record.id === 'dev-api').status, 'running');
  assert.ok(!app.modal);
  await app.switchTab('forwards');
  assert.deepEqual(app.visibleRows.map(record => record.profile.id), ['dev', 'stage']);
  await renderOnce();
  assert.match(captureCharFrame(), /All profiles\s+1 running/);
  mockInput.pressKey('h');
  assert.deepEqual(app.visibleRows.map(record => record.id), ['dev-api']);
  await app.controlCurrent(app.visibleRows[0]);
  assert.equal(app.forwards.records[0].status, 'stopped');
  assert.equal(app.forwards.records[0].profile.id, 'dev');
});

test('editing a connection preserves its owner and returns without changing the resource view', async t => {
  const { app } = await uiHarness(t, 100, 30);
  app.profile = profiles[1];
  const record = app.forwards.records[0];
  let returned = false;
  await app.forwardForm(record.spec, { record, onReturn: () => { returned = true; } });
  app.modal.controls.get('localPort').value = '18082';
  await app.modal.submit();
  const saved = app.store.data.forwards.find(entry => entry.id === record.id);
  assert.equal(saved.profileId, 'dev');
  assert.equal(saved.spec.localPort, 18082);
  assert.equal(app.tab, 'services');
  assert.equal(returned, true);
});

for (const [width, height] of [[80, 24], [140, 40]]) {
  test(`resource card exposes ports, connections and Pods at ${width}×${height}`, async t => {
    const { app, mockInput, renderOnce, captureCharFrame, waitFor } = await uiHarness(t, width, height);
    assert.equal(app.tab, 'services');
    const tabs = captureCharFrame().split('\n').find(line => line.includes('1  Cluster'));
    assert.match(tabs, /2  Favorites\s+3  Port Forwards\s+4  Templates/);
    assert.deepEqual(app.resourceTable.relatedForwards(resource).map(record => record.profileId), ['dev']);
    mockInput.pressEnter();
    await waitFor(() => app.modal?.focusables.length > 2 && app.renderer.currentFocusedRenderable === app.modal.focusables[1]);
    await renderOnce();
    const frame = captureCharFrame();
    assert.match(frame, /8080\/TCP/);
    assert.match(frame, /localhost:18080/);
    assert.match(frame, /Copy address/);
    assert.match(frame, /Close/);
    if (height >= 40) assert.match(frame, /api-123/);
    assert.doesNotMatch(frame, /localhost:18081/);
    const close = app.modal.focusables.at(-1);
    assert.ok(close.y + close.height <= height, 'resource actions must fit inside the terminal');
    let started;
    app.forwards.start = async record => { started = record.id; };
    mockInput.pressEnter();
    await waitFor(() => started === 'dev-api');
    assert.equal(app.tab, 'services');
    assert.ok(app.modal, 'connecting must leave the resource card open');
    mockInput.pressEscape();
    await waitFor(() => !app.modal);
    await app.switchTab('favorites');
    app.store.data.favorites = [{ type: 'resource', target: { kind: 'service', name: 'api', namespace: 'default' } }];
    app.resourceTable.renderTable();
    mockInput.pressEnter();
    await waitFor(() => app.modal?.focusables.length > 2 && app.renderer.currentFocusedRenderable === app.modal.focusables[1]);
    assert.equal(app.tab, 'favorites');
    assert.match(app.modal.dialog.title, /service\/api/);
  });
}

test('a favorite offers one forward action from initial setup through stop and restart', async t => {
  const { app, mockInput, waitFor, renderOnce, captureCharFrame } = await uiHarness(t, 100, 32, []);
  await app.toggleFavorite(resource);
  await app.switchTab('favorites');
  await renderOnce();
  const frame = captureCharFrame();
  assert.match(frame, /Forward port…/);
  assert.doesNotMatch(frame, /New forward|Add local port|Show in Port Forwards|Move up|Move down/);
  mockInput.pressKey('n');
  assert.ok(!app.modal);

  const forward = t.mock.method(app, 'toggleForward');
  mockInput.pressKey('f');
  await waitFor(() => forward.mock.callCount() === 1);
  await forward.mock.calls[0].result;
  assert.equal(app.modal.dialog.title, 'Forward a port');
  assert.equal(app.renderer.currentFocusedRenderable.buttonLabel, 'Start forward');
  const localPort = Number(app.modal.controls.get('localPort').value);
  mockInput.pressEnter();
  await waitFor(() => app.forwards.records[0]?.status === 'running' && !app.modal);
  assert.equal(app.tab, 'favorites');
  const first = app.forwards.records[0];
  assert.equal(first.spec.localPort, localPort);
  assert.equal(first.spec.remotePort, 'http');
  assert.equal(first.profileId, 'dev');
  for (const [label, status] of [['Stop forward', 'stopped'], ['Start forward', 'running']]) {
    await new Promise(setImmediate);
    await renderOnce();
    assert.ok(captureCharFrame().includes(label));
    mockInput.pressKey('f');
    await waitFor(() => app.forwards.records[0].status === status);
    assert.deepEqual(app.store.data.forwards.map(record => record.id), [first.id]);
  }
});

test('card selection controls the exact mapping and keeps additional local ports inside the card', async t => {
  const { app, mockInput, mockMouse, waitFor, renderOnce, captureCharFrame } = await uiHarness(t, 140, 40);
  app.rows = [{ ...resource, ports: [...resource.ports, { name: 'metrics', port: 9090 }] }];
  app.resourceTable.renderTable();
  mockInput.pressEnter();
  await waitFor(() => app.modal?.dialog.title === 'service/api');
  const ports = app.renderer.currentFocusedRenderable;
  assert.deepEqual(ports.options.map(option => option.name), ['8080/TCP · http → localhost:18080 · Stopped', '9090/TCP · metrics']);
  await renderOnce();
  const positions = app.modal.focusables.map(control => [control.x, control.y, control.width, control.height]);
  await mockMouse.click(ports.x + 1, ports.y + 1);
  assert.equal(ports.getSelectedIndex(), 1);
  assert.equal(app.modal.dialog.title, 'service/api');
  assert.ok(!app.modal.busy);
  await renderOnce();
  assert.deepEqual(app.modal.focusables.map(control => [control.x, control.y, control.width, control.height]), positions);
  for (const key of ['n', 'e', 'c', 'o']) assert.equal(app.modal.focusables.find(button => button.shortcut === key).canActivate(), false);
  const form = t.mock.method(app, 'forwardForm');
  const primary = app.modal.focusables.find(button => button.shortcut === 'f');
  await mockMouse.click(primary.x + 1, primary.y);
  await waitFor(() => form.mock.callCount() === 1);
  await form.mock.calls[0].result;
  assert.equal(app.modal.dialog.title, 'Forward a port');
  mockInput.pressEscape();
  await waitFor(() => app.modal?.dialog.title === 'service/api');
  assert.equal(app.renderer.currentFocusedRenderable.getSelectedOption().name, '9090/TCP · metrics');
  mockInput.pressArrow('up');
  mockInput.pressKey('n');
  await waitFor(() => form.mock.callCount() === 2);
  await form.mock.calls[1].result;
  const extraPort = Number(app.modal.controls.get('localPort').value);
  assert.notEqual(extraPort, 18080);
  mockInput.pressEnter();
  await waitFor(() => app.modal?.dialog.title === 'service/api' && app.forwards.records.some(record => record.status === 'running'));
  const chosen = app.renderer.currentFocusedRenderable.getSelectedOption();
  assert.ok(chosen.name.includes(`localhost:${extraPort}`));
  mockInput.pressKey('f');
  await waitFor(() => app.forwards.records.every(record => record.status === 'stopped'));
  assert.equal(app.store.data.forwards.filter(record => record.profileId === 'dev').length, 2);
});

test('choosing among saved forwards affects only the selected mapping and respects the displayed action', async t => {
  const { app, mockInput, waitFor } = await uiHarness(t, 110, 32, [
    { id: 'a', profileId: 'dev', spec }, { id: 'b', profileId: 'dev', spec: { ...spec, localPort: 18082 } },
  ]);
  await app.forwards.start({ id: 'a' });
  mockInput.pressKey('f');
  await waitFor(() => app.modal?.dialog.title === 'Choose a port forward');
  const options = app.renderer.currentFocusedRenderable.options;
  assert.match(options[0].description, /Stop forward/);
  assert.match(options[1].description, /Start forward/);
  mockInput.pressArrow('down');
  await app.forwards.start({ id: 'b' });
  mockInput.pressEnter();
  await new Promise(setImmediate);
  assert.deepEqual(app.forwards.records.map(record => record.status), ['running', 'running']);
  mockInput.pressKey('f');
  await waitFor(() => app.modal?.dialog.title === 'Choose a port forward');
  mockInput.pressArrow('down');
  mockInput.pressEnter();
  await waitFor(() => app.forwards.records[1].status === 'stopped');
  assert.equal(app.forwards.records[0].status, 'running');
});

test('a Pod never targets a Service forward through an implicit selector match', async t => {
  const { app, mockInput, waitFor } = await uiHarness(t, 100, 30);
  const pod = { ...resource, kind: 'pod', id: 'pod:default/api', compact: false, ready: '1/1', containers: ['api'],
    restarts: 0, status: 'Running', labels: { app: 'api' }, ports: [] };
  app.live.list = async () => [pod];
  app.live.servicesFor = t.mock.fn(async () => [resource]);
  await app.switchTab('pods');
  await app.forwards.start({ id: 'dev-api' });
  const form = t.mock.method(app, 'forwardForm');
  mockInput.pressKey('f');
  await waitFor(() => form.mock.callCount() > 0);
  await form.mock.calls[0].result;
  assert.equal(app.live.servicesFor.mock.callCount(), 0);
  assert.equal(app.forwards.records[0].status, 'running');
  assert.equal(app.modal.controls.get('remotePort').value, '');
  assert.equal(app.renderer.currentFocusedRenderable, app.modal.controls.get('remotePort'));
});

test('a favorite can stop its running forward when resource details are unavailable', async t => {
  const { app, mockInput, waitFor, waitForFrame } = await uiHarness(t, 100, 30);
  await app.toggleFavorite(resource);
  await app.switchTab('favorites');
  await app.forwards.start({ id: 'dev-api' });
  app.live.resource = async () => { throw new Error('Cluster is offline'); };
  mockInput.pressEnter();
  const frame = await waitForFrame(frame => frame.includes('Cluster is offline'));
  assert.match(frame, /localhost:18080 · Running/);
  assert.match(frame, /Stop forward/);
  mockInput.pressKey('f');
  await waitFor(() => app.forwards.records[0].status === 'stopped');
  assert.equal(app.modal.dialog.title, 'service/api');
});

test('Cluster exposes Services and Pods shortcuts and switches from the list and buttons', async t => {
  const { app, mockInput, mockMouse, renderOnce, captureCharFrame, waitFor } = await uiHarness(t, 100, 30);
  assert.match(captureCharFrame(), /s Services\s+p Pods/);
  mockInput.pressKey('p');
  await waitFor(() => app.tab === 'pods' && !app.cluster.request);
  mockInput.pressKey('s');
  await waitFor(() => app.tab === 'services' && !app.cluster.request);
  await renderOnce();
  const pods = app.resourceButtons[1];
  await mockMouse.click(pods.x + 1, pods.y);
  await waitFor(() => app.tab === 'pods' && !app.cluster.request);
  app.navigation.focus(app.resourceButtons[0]);
  mockInput.pressKey('s');
  await waitFor(() => app.tab === 'services' && !app.cluster.request);
  app.filter.focus();
  mockInput.pressKey('p');
  assert.equal(app.tab, 'services');
  assert.equal(app.filter.value, 'p');
});

for (const [width, height] of [[80, 24], [100, 32]]) {
  test(`resource card positions stay fixed across port selection and forward state at ${width}×${height}`, async t => {
    const { app, mockInput, waitFor, renderOnce } = await uiHarness(t, width, height);
    app.rows = [{ ...resource, ports: [...resource.ports, { name: 'metrics', port: 9090 }] }];
    app.resourceTable.renderTable();
    mockInput.pressEnter();
    await waitFor(() => app.modal?.dialog.title === 'service/api');
    await renderOnce();
    const positions = () => app.modal.focusables.map(control => [control.x, control.y, control.width, control.height]);
    const initial = positions();
    mockInput.pressArrow('down');
    await renderOnce();
    assert.deepEqual(positions(), initial);
    mockInput.pressArrow('up');
    await app.forwards.start({ id: 'dev-api' });
    app.modal.refresh();
    await renderOnce();
    assert.deepEqual(positions(), initial);
    assert.equal(app.modal.focusables.find(button => button.shortcut === 'o').canActivate(), true);
    await app.forwards.stop({ id: 'dev-api' });
    app.modal.refresh();
    await renderOnce();
    assert.deepEqual(positions(), initial);
  });
}

for (const [width, height] of [[80, 24], [120, 36]]) {
  test(`template port form is fully reachable with arrows at ${width}×${height}`, async t => {
    const { app, mockInput, renderOnce } = await uiHarness(t, width, height);
    const target = { ...resource, ports: [{ name: 'grpc', port: 12089 }, { name: 'monitoring', port: 9105 }, ...resource.ports] };
    app.configureGroupForward(target, app.profile, { pending: [] }, () => {}, () => {});
    await renderOnce();
    const modal = app.modal;
    const remote = modal.controls.get('remotePort');
    const local = modal.controls.get('localPort');
    const advanced = modal.focusables.find(control => control.buttonLabel === 'Advanced…');
    const back = modal.focusables.at(-2);
    const add = modal.focusables.at(-1);
    const focused = () => app.renderer.currentFocusedRenderable;
    assert.equal(focused(), remote);
    mockInput.pressArrow('right');
    assert.equal(focused(), local);
    mockInput.pressArrow('up');
    assert.equal(focused(), remote);
    assert.equal(remote.getSelectedIndex(), 0);
    mockInput.pressArrow('down');
    mockInput.pressArrow('down');
    assert.equal(remote.getSelectedIndex(), 2);
    mockInput.pressArrow('down');
    assert.equal(focused(), local);
    mockInput.pressArrow('down');
    assert.equal(focused(), advanced);
    mockInput.pressArrow('down');
    assert.equal(focused(), back);
    mockInput.pressArrow('right');
    assert.equal(focused(), add);
    mockInput.pressArrow('left');
    assert.equal(focused(), back);
    mockInput.pressArrow('up');
    assert.equal(focused(), advanced);
    mockInput.pressArrow('up');
    assert.equal(focused(), local);
    mockInput.pressArrow('up');
    assert.equal(focused(), remote);
  });
}

test('inputs retain cursor editing and spatial navigation handles menus and confirmations', async t => {
  const { app, mockInput, renderOnce } = await uiHarness(t, 100, 32);
  app.form('Edit', [{ key: 'value', label: 'Value', value: 'ab😀' }], () => {});
  await renderOnce();
  const field = app.modal.controls.get('value');
  const cancel = app.modal.focusables.at(-2);
  const save = app.modal.focusables.at(-1);
  mockInput.pressKey('END');
  const end = field.cursorOffset;
  mockInput.pressArrow('left');
  assert.ok(field.cursorOffset < end);
  assert.equal(app.renderer.currentFocusedRenderable, field);
  mockInput.pressArrow('right');
  assert.equal(field.cursorOffset, end);
  mockInput.pressArrow('down');
  assert.equal(app.renderer.currentFocusedRenderable, cancel);
  mockInput.pressArrow('right');
  assert.equal(app.renderer.currentFocusedRenderable, save);
  mockInput.pressArrow('up');
  assert.equal(app.renderer.currentFocusedRenderable, field);
  app.pick('Choose', [{ name: 'First', value: 1 }, { name: 'Last', value: 2 }], () => {});
  await renderOnce();
  const list = app.renderer.currentFocusedRenderable;
  mockInput.pressArrow('down');
  assert.equal(list.getSelectedIndex(), 1);
  mockInput.pressArrow('down');
  assert.ok(app.uiButtons.has(app.renderer.currentFocusedRenderable));
  mockInput.pressArrow('up');
  assert.equal(app.renderer.currentFocusedRenderable, list);
  app.confirm('Confirm', 'Description', 'Apply', () => {});
  await renderOnce();
  const scroll = app.modal.focusables[0];
  mockInput.pressArrow('up');
  assert.equal(app.renderer.currentFocusedRenderable, scroll);
  mockInput.pressArrow('down');
  assert.ok(app.uiButtons.has(app.renderer.currentFocusedRenderable));
});

test('arrows reach scrolled form fields and return from the footer without Tab', async t => {
  const { app, mockInput, renderOnce } = await uiHarness(t, 80, 24);
  app.form('Long form', Array.from({ length: 12 }, (_, index) => ({ key: String(index), label: `Field ${index}`, value: index })), () => {});
  await renderOnce();
  for (let index = 1; index < 12; index++) {
    mockInput.pressArrow('down');
    await renderOnce();
    const field = app.modal.controls.get(String(index));
    assert.equal(app.renderer.currentFocusedRenderable, field);
    assert.ok(field.y >= app.modal.scroll.viewport.y && field.y < app.modal.scroll.viewport.y + app.modal.scroll.viewport.height);
  }
  mockInput.pressArrow('down');
  assert.equal(app.renderer.currentFocusedRenderable, app.modal.focusables.at(-2));
  mockInput.pressArrow('up');
  assert.equal(app.renderer.currentFocusedRenderable, app.modal.controls.get('11'));
});

test('arrows connect main tabs, search, resources, details and footer actions', async t => {
  const { app, mockInput, renderOnce } = await uiHarness(t, 140, 40);
  mockInput.pressArrow('right');
  assert.equal(app.renderer.currentFocusedRenderable, app.sidebar);
  mockInput.pressArrow('left');
  assert.equal(app.renderer.currentFocusedRenderable, app.table);
  mockInput.pressArrow('up');
  assert.ok(app.renderer.currentFocusedRenderable === app.filter || app.resourceButtons.includes(app.renderer.currentFocusedRenderable));
  mockInput.pressArrow('up');
  assert.ok(app.tabBoxes.includes(app.renderer.currentFocusedRenderable));
  app.table.focus();
  mockInput.pressArrow('down');
  assert.ok(app.actionButtons.includes(app.renderer.currentFocusedRenderable));
  mockInput.pressArrow('down');
  await renderOnce();
  assert.ok(app.keyButtons.includes(app.renderer.currentFocusedRenderable));
});

test('profiles and template editor expose their footer through arrow navigation', async t => {
  const { app, mockInput, renderOnce } = await uiHarness(t, 100, 32);
  app.openProfiles();
  await renderOnce();
  const list = app.renderer.currentFocusedRenderable;
  mockInput.pressKey('END');
  mockInput.pressArrow('down');
  assert.ok(app.uiButtons.has(app.renderer.currentFocusedRenderable));
  mockInput.pressArrow('up');
  assert.equal(app.renderer.currentFocusedRenderable, list);
  app.editGroup();
  await renderOnce();
  mockInput.pressArrow('down');
  assert.equal(app.renderer.currentFocusedRenderable.buttonLabel, 'Add forward');
  mockInput.pressArrow('down');
  assert.ok(app.renderer.currentFocusedRenderable.buttonLabel.includes('Start with'));
  mockInput.pressArrow('down');
  assert.ok(['Cancel', 'Save'].includes(app.renderer.currentFocusedRenderable.buttonLabel));
});

test('live logs, log record details and export are reachable by arrows', async t => {
  const { app, mockInput, renderOnce, waitFor } = await uiHarness(t, 120, 36);
  app.logStreams.changeLogSources = async () => {};
  await app.startLogSources(app.profile, [{ pod: { ...resource, kind: 'pod' }, container: 'api' }]);
  const source = { label: 'api', caption: 'api' };
  app.logs.buffer.add('first record', false, source);
  app.logs.buffer.add('last record', false, source);
  app.flushLogs(true);
  app.resize();
  await renderOnce();
  app.logViewport.selectRecordAt(0);
  mockInput.pressArrow('up');
  assert.ok(app.renderer.currentFocusedRenderable === app.filter || app.renderer.currentFocusedRenderable === app.logFilterButton);
  app.filter.focus();
  const matches = t.mock.method(app, 'findLogMatch', () => {});
  mockInput.pressArrow('down', { ctrl: true });
  assert.equal(matches.mock.callCount(), 1);
  mockInput.pressArrow('down');
  assert.equal(app.renderer.currentFocusedRenderable, app.logViewport);
  app.logViewport.selectRecordAt(0);
  mockInput.pressEnter();
  await waitFor(() => app.modal?.contentControl);
  await renderOnce();
  const content = app.modal.contentControl;
  mockInput.pressArrow('up');
  assert.notEqual(app.renderer.currentFocusedRenderable, content);
  const search = app.modal.search;
  search.focus();
  mockInput.pressArrow('down');
  assert.equal(app.renderer.currentFocusedRenderable, content);
  content.scrollTo(Infinity);
  mockInput.pressArrow('down');
  assert.ok(app.uiButtons.has(app.renderer.currentFocusedRenderable));
  app.closeModal();
  app.exportLogs();
  await renderOnce();
  const mode = app.modal.focusables[0];
  mockInput.pressArrow('down');
  assert.equal(mode.getSelectedIndex(), 1);
  mockInput.pressArrow('down');
  assert.equal(app.renderer.currentFocusedRenderable, app.modal.focusables[1]);
  mockInput.pressArrow('down');
  assert.equal(app.renderer.currentFocusedRenderable, app.modal.focusables[2]);
  mockInput.pressArrow('down');
  assert.ok(app.uiButtons.has(app.renderer.currentFocusedRenderable));
});

test('adding a forward returns to the template list and selects the added entry', async t => {
  const { app, mockInput, renderOnce, waitFor } = await uiHarness(t, 100, 32);
  let onReturn;
  app.addGroupForward = (state, callback) => { onReturn = callback; app.showModal('Add forward'); };
  app.editGroup();
  app.modal.focusables[0].value = 'Backend';
  const add = () => app.modal.focusables.find(control => control.shortcut === 'a');
  app.navigation.focus(add());
  onReturn = undefined;
  mockInput.pressEnter();
  await waitFor(() => typeof onReturn === 'function');
  onReturn(app.store.data.forwards[0]);
  await renderOnce();
  let list = app.modal.focusables[1];
  assert.equal(app.renderer.currentFocusedRenderable, list);
  assert.equal(list.getSelectedOption().value, 'dev-api');
  assert.equal(app.modal.focusables[0].value, 'Backend');
  app.navigation.focus(add());
  onReturn = undefined;
  mockInput.pressEnter();
  await waitFor(() => typeof onReturn === 'function');
  onReturn({ id: 'new-db', profileId: null, spec: { ...spec, name: 'db', localPort: 15432 } });
  await renderOnce();
  list = app.modal.focusables[1];
  assert.equal(app.renderer.currentFocusedRenderable, list);
  assert.equal(list.getSelectedOption().value, 'new-db');
  app.navigation.focus(add());
  onReturn = undefined;
  mockInput.pressEnter();
  await waitFor(() => typeof onReturn === 'function');
  onReturn();
  await renderOnce();
  list = app.modal.focusables[1];
  assert.equal(app.renderer.currentFocusedRenderable, list);
  assert.equal(list.getSelectedOption().value, 'new-db');
});

test('template local port follows the selected service port and preserves manual overrides', async t => {
  const { app, mockInput, renderOnce } = await uiHarness(t, 100, 32, [
    { id: 'existing', profileId: 'stage', spec: { ...spec, localPort: 16035 } },
  ]);
  const target = { ...resource, ports: [{ name: 'grpc', port: 16035 }, { name: 'monitoring', port: 9105 }, { name: 'jmx', port: 9130 }] };
  app.configureGroupForward(target, app.profile, { pending: [] }, () => {}, () => {});
  await renderOnce();
  let remote = app.modal.controls.get('remotePort');
  let local = app.modal.controls.get('localPort');
  assert.equal(local.value, '16035');
  mockInput.pressArrow('down');
  assert.equal(local.value, '9105');
  mockInput.pressArrow('down');
  assert.equal(local.value, '9130');
  local.value = '20000';
  mockInput.pressArrow('up');
  assert.equal(local.value, '20000');
  const advanced = app.modal.focusables.find(button => button.buttonLabel === 'Advanced…');
  app.navigation.focus(advanced);
  mockInput.pressEnter();
  await new Promise(setImmediate);
  await renderOnce();
  remote = app.modal.controls.get('remotePort');
  local = app.modal.controls.get('localPort');
  assert.equal(remote.getSelectedOption().value, 'monitoring');
  assert.equal(local.value, '20000');
  app.navigation.focus(remote);
  mockInput.pressArrow('up');
  assert.equal(local.value, '20000');
});

test('template forward form uses buttons without A and B shortcuts', async t => {
  const { app, mockInput, renderOnce, waitFor } = await uiHarness(t, 100, 32);
  let added;
  let backed = 0;
  const open = () => app.configureGroupForward(resource, app.profile, { pending: [] }, record => { added = record; }, () => { backed++; });
  open();
  await renderOnce();
  const modal = app.modal;
  assert.equal(modal.focusables.at(-2).shortcut, '');
  assert.equal(modal.focusables.at(-1).shortcut, '');
  mockInput.pressKey('A');
  mockInput.pressKey('B');
  await new Promise(setImmediate);
  assert.equal(app.modal, modal);
  assert.equal(added, undefined);
  assert.equal(backed, 0);
  app.navigation.focus(modal.focusables.at(-1));
  mockInput.pressEnter();
  await waitFor(() => Boolean(added));
  assert.equal(added.spec.remotePort, 'http');
  open();
  app.navigation.focus(app.modal.focusables.find(button => button.buttonLabel === 'Advanced…'));
  mockInput.pressEnter();
  await waitFor(() => app.modal?.controls.has('address'));
  app.navigation.focus(app.modal.focusables.find(button => button.buttonLabel === 'Hide advanced settings'));
  mockInput.pressKey('A');
  mockInput.pressKey('B');
  assert.equal(backed, 0);
  app.navigation.focus(app.modal.focusables.at(-2));
  mockInput.pressEnter();
  await waitFor(() => backed === 1);
});

test('R removes the selected forward from a template and D leaves it alone', async t => {
  const { app, mockInput, renderOnce } = await uiHarness(t, 100, 32);
  app.editGroup({ id: 'backend', name: 'Backend', autostart: false, forwardIds: ['dev-api', 'stage-api'] });
  await renderOnce();
  const list = app.modal.focusables[1];
  assert.equal(app.modal.focusables.find(button => button.buttonLabel === 'Remove').shortcut, 'r');
  mockInput.pressKey('d');
  assert.equal(list.options.length, 2);
  mockInput.pressKey('r');
  assert.deepEqual(list.options.map(option => option.value), ['stage-api']);
  assert.equal(app.store.data.forwards.length, 2);
});

test('vertical focus enters the first enabled control of the destination row', async t => {
  const { app, mockInput, renderOnce } = await uiHarness(t, 100, 32);
  app.editGroup({ id: 'backend', name: 'Backend', autostart: false, forwardIds: ['dev-api', 'stage-api'] });
  await renderOnce();
  mockInput.pressKey('END');
  mockInput.pressArrow('down');
  assert.equal(app.renderer.currentFocusedRenderable.buttonLabel, 'Add forward');
  mockInput.pressArrow('right');
  assert.equal(app.renderer.currentFocusedRenderable.buttonLabel, 'Remove');
  mockInput.pressArrow('down');
  mockInput.pressArrow('down');
  assert.equal(app.renderer.currentFocusedRenderable.buttonLabel, 'Cancel');
  app.confirm('Confirm', 'Text', 'Apply', () => {});
  await renderOnce();
  mockInput.pressArrow('up');
  mockInput.pressArrow('down');
  assert.equal(app.renderer.currentFocusedRenderable.buttonLabel, 'Cancel');
});

test('templates reorder with brackets, retain selection and keep order after editing', async t => {
  const { app, mockInput, waitFor } = await uiHarness(t, 120, 36);
  app.store.data.groups = ['Backend', 'Hidden', 'Mesh'].map((name, index) => ({ id: String(index), name, autostart: false, forwardIds: [] }));
  await app.switchTab('groups');
  app.resourceTable.selectRow(2);
  mockInput.pressKey('[');
  await waitFor(() => app.store.data.groups.map(group => group.name).join(',') === 'Backend,Mesh,Hidden');
  assert.equal(app.resourceTable.current().name, 'Mesh');
  mockInput.pressKey(']');
  await waitFor(() => app.store.data.groups.map(group => group.name).join(',') === 'Backend,Hidden,Mesh');
  app.filter.value = 'Mesh';
  app.resourceTable.renderTable();
  mockInput.pressKey('[');
  await new Promise(setImmediate);
  assert.deepEqual(app.store.data.groups.map(group => group.name), ['Backend', 'Hidden', 'Mesh']);
  app.filter.value = '';
  app.resourceTable.renderTable();
  app.resourceTable.selectRow(0);
  mockInput.pressKey(']');
  await waitFor(() => app.store.data.groups[1].name === 'Backend');
  app.editGroup(app.resourceTable.current());
  await app.modal.submit();
  assert.deepEqual(app.store.data.groups.map(group => group.name), ['Hidden', 'Backend', 'Mesh']);
  assert.equal(app.resourceTable.current().name, 'Backend');
});

test('shared bracket ordering preserves favorite behavior', async t => {
  const { app, mockInput, waitFor } = await uiHarness(t, 100, 32);
  app.store.data.favorites = ['api', 'db'].map(name => ({ type: 'resource', target: { kind: 'service', namespace: 'default', name } }));
  await app.switchTab('favorites');
  mockInput.pressKey(']');
  await waitFor(() => app.store.data.favorites[0].target.name === 'db');
  assert.equal(app.resourceTable.current().name, 'api');
  mockInput.pressKey('[');
  await waitFor(() => app.store.data.favorites[0].target.name === 'api');
});
