import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogBuffer } from '../src/logs.js';
import { LogStreams } from '../src/log-streams.js';
import { LogViewport } from '../src/log-viewport.js';

const line = (index, message = `record ${index}`) => `${new Date(Date.UTC(2026, 10, 3, 12) + index * 1000).toISOString()} ${message}`;
const sourceOf = (name = 'pod') => ({ pod: { kind: 'pod', name, namespace: 'default', uid: name, containers: ['app'], terminalContainers: [] },
  container: 'app', label: `default/${name}/app`, caption: '', status: 'live' });

function viewportOf() {
  const viewport = Object.create(LogViewport.prototype);
  Object.assign(viewport, { records: [], recordSource: null, entries: [], entriesByRecord: new Map(), allEntries: new Map(),
    query: '', wrap: false, filterOnly: false, following: true, scrollTop: 0, total: 0, matchCount: 0,
    contentWidth: 120, contentHeight: 5, draw() {} });
  return viewport;
}

function session(t, lines = Array.from({ length: 1500 }, (_, index) => line(index))) {
  const source = sourceOf();
  const viewport = viewportOf();
  const tails = [];
  const callbacks = new Map();
  const backend = {
    resource: async (profile, pod) => pod,
    logs(profile, pod, container, handlers, { follow = true, tail } = {}) {
      let finish;
      const done = new Promise(resolve => { finish = resolve; });
      const handle = { done, stop: async () => { finish({ code: 0 }); await done; } };
      if (follow) callbacks.set(pod.name, handlers);
      else tails.push(tail);
      queueMicrotask(() => {
        for (const text of lines.slice(-tail)) handlers.onLine(text, false);
        if (!follow) { backend.beforeHistoryClose?.(); finish({ code: 0 }); }
      });
      return handle;
    },
  };
  const app = {
    logs: { profile: {}, sources: [source], buffer: new LogBuffer(), sourceRevision: 1 }, logViewport: viewport,
    cluster: { backend: () => backend }, beginAction: () => new AbortController(),
    setStatus(message) { this.status = message; }, updateHeader() {}, updateLogMeta() {}, resetLogHistory() { viewport.goEnd(); },
    flushLogs() { viewport.setRecords(this.logs.buffer.matching()); },
  };
  const streams = new LogStreams(app);
  viewport.onChange = () => streams.scheduleLogHistory();
  t.after(async () => {
    streams.cancelLogHistory(app.logs);
    await Promise.allSettled(app.logs.sources.map(item => streams.stopLogSource(item)));
    await Promise.allSettled([...streams.logClosures]);
  });
  return { source, viewport, backend, app, streams, lines, tails, callbacks };
}

test('session history retains records beyond both former buffer limits', () => {
  const buffer = new LogBuffer();
  const source = sourceOf();
  const first = line(0, 'x'.repeat(1100));
  buffer.add(first, false, source);
  for (let index = 1; index < 2500; index++) buffer.add(line(index, 'x'.repeat(1100)), false, source);
  assert.equal(buffer.records.length, 2500);
  assert.equal(buffer.records[0].text, first);
  assert.ok(buffer.records.reduce((bytes, record) => bytes + Buffer.byteLength(record.text), 0) > 2 * 1024 * 1024);
});

test('merging history keeps source identity, repeated lines, nanosecond order and live counters', () => {
  const source = sourceOf();
  const other = sourceOf('other');
  const buffer = new LogBuffer();
  const history = new LogBuffer();
  const duplicate = '2026-11-03T12:00:00.000000002Z duplicate';
  buffer.add(duplicate, false, source);
  const existing = buffer.records[0];
  history.add(duplicate, false, source);
  history.add(duplicate, false, source);
  history.add(duplicate, false, other);
  history.add('2026-11-03T12:00:00Z oldest', false, source);
  history.add('2026-11-03T12:00:00.000000001Z middle', false, source);
  assert.equal(buffer.merge(history).length, 4);
  assert.equal(buffer.sequence, 1);
  assert.equal(buffer.records.length, 5);
  assert.match(buffer.records[0].text, /oldest$/);
  assert.match(buffer.records[1].text, /middle$/);
  assert.equal(buffer.records[2], existing);
  assert.equal(buffer.records.filter(record => record.source === source && record.text === duplicate).length, 2);
  assert.equal(buffer.merge(history).length, 0);
});

test('history expansion keeps the reading position, selection and concurrent live records', async t => {
  const { source, viewport, backend, app, streams, tails, callbacks } = session(t);
  streams.openLogStream(app.logs, source);
  await Promise.resolve();
  app.flushLogs();
  viewport.setTop(100, false);
  const anchor = viewport.anchor();
  const selected = viewport.records[102];
  viewport.selectedRecord = selected;
  viewport.selection = { a: { record: selected, offset: 0 }, b: { record: selected, offset: 5 } };
  const sequence = app.logs.buffer.sequence;
  backend.beforeHistoryClose = () => callbacks.get('pod').onLine(line(1500), false);
  await streams.loadLogHistory();
  assert.deepEqual(tails, [1000]);
  assert.equal(viewport.anchor().record, anchor.record);
  assert.equal(viewport.anchor().offset, anchor.offset);
  assert.equal(viewport.selectedRecord, selected);
  assert.equal(viewport.selection.a.record, selected);
  assert.equal(viewport.following, false);
  assert.equal(app.logs.buffer.records.at(-1).text, line(1500));
  assert.equal(app.logs.buffer.sequence, sequence + 1);
  assert.equal(app.logs.buffer.records.length, 1001);
  viewport.goEnd();
  assert.equal(viewport.following, true);
  assert.equal(viewport.scrollTop, viewport.maxTop);
});

test('a line obtained from history before the live stream arrives is shown once', async t => {
  const { source, app, streams, lines, callbacks } = session(t);
  streams.openLogStream(app.logs, source);
  await Promise.resolve();
  lines.push(line(1500));
  await streams.loadLogHistory();
  const count = app.logs.buffer.records.length;
  callbacks.get('pod').onLine(line(1500), false);
  assert.equal(app.logs.buffer.records.length, count);
  assert.equal(app.logs.buffer.records.filter(record => record.text === line(1500)).length, 1);
  callbacks.get('pod').onLine(line(1501), false);
  assert.equal(app.logs.buffer.records.length, count + 1);
});

test('search loads older pages automatically and discovers a record outside the initial tail', async t => {
  const { source, viewport, app, streams, tails } = session(t);
  streams.openLogStream(app.logs, source);
  await Promise.resolve();
  app.flushLogs();
  viewport.setQuery('missing');
  viewport.setQuery('record 10');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('History search did not complete')), 3000);
    const status = app.setStatus;
    app.setStatus = function (message) {
      status.call(this, message);
      if (source.historyComplete) { clearTimeout(timer); resolve(); }
    };
  });
  assert.deepEqual(tails, [1000, 2000]);
  assert.equal(app.logs.buffer.records.length, 1500);
  assert.ok(viewport.entries.some(entry => entry.record.text === line(10) && entry.hitCount));
  assert.ok(viewport.currentMatch);
  assert.equal(app.logs.historyTimer, null);
});

test('scrolling upward in a short viewport pauses following and schedules history', async t => {
  const { source, viewport, app, streams } = session(t, [line(1)]);
  streams.openLogStream(app.logs, source);
  await Promise.resolve();
  app.flushLogs();
  assert.equal(viewport.maxTop, 0);
  viewport.moveBy(-1);
  assert.equal(viewport.following, false);
  assert.ok(app.logs.historyTimer);
  await streams.loadLogHistory();
  assert.equal(source.historyComplete, true);
});

test('refresh preserves previously loaded history when the server has rotated its older logs', async t => {
  const { source, app, streams, lines, tails } = session(t);
  streams.openLogStream(app.logs, source);
  await Promise.resolve();
  await streams.loadLogHistory();
  await streams.loadLogHistory();
  const oldest = app.logs.buffer.records[0];
  lines.splice(0, 1200);
  await streams.reloadLogs();
  assert.equal(app.logs.buffer.records.length, 1500);
  assert.equal(app.logs.buffer.records[0], oldest);
  assert.deepEqual(tails, [1000, 2000, 2000]);
});

test('changing sources cancels history and rejects its late results', async t => {
  const { source, backend, app, streams } = session(t);
  let release;
  let signal;
  backend.resource = (profile, pod, requestSignal) => {
    signal = requestSignal;
    return new Promise(resolve => { release = () => resolve(pod); });
  };
  const loading = streams.loadLogHistory();
  const replacement = sourceOf('replacement');
  await streams.changeLogSources([replacement]);
  assert.equal(signal.aborted, true);
  release();
  await loading;
  assert.equal(app.logs.sources[0].pod.name, 'replacement');
  assert.ok(app.logs.buffer.records.every(record => record.source !== source));
  assert.equal(streams.logClosures.size, 0);
});

test('appending live logs reuses the viewport entries for existing history', () => {
  const source = sourceOf();
  const buffer = new LogBuffer();
  const viewport = viewportOf();
  buffer.add(line(1), false, source);
  viewport.setRecords(buffer.matching());
  const entry = viewport.entries[0];
  buffer.add(line(2), false, source);
  viewport.setRecords(buffer.matching());
  assert.equal(viewport.entries[0], entry);
  assert.equal(viewport.entries.length, 2);
  assert.equal(viewport.total, 2);
});

test('a history error preserves live records and does not retry in a loop', async t => {
  const { source, backend, viewport, app, streams } = session(t);
  streams.openLogStream(app.logs, source);
  await Promise.resolve();
  app.flushLogs();
  const first = app.logs.buffer.records[0];
  backend.resource = async () => { throw new Error('connection unavailable'); };
  viewport.setQuery('missing');
  await streams.loadLogHistory();
  assert.equal(app.logs.historyError, 'connection unavailable');
  assert.equal(app.logs.buffer.records.length, 500);
  assert.equal(app.logs.buffer.records[0], first);
  assert.equal(app.logs.historyTimer, null);
  assert.ok(source.handle);
  assert.equal(streams.logClosures.size, 0);
});

test('End keeps following live logs when background search discovers an older match', async t => {
  const { source, viewport, app, streams } = session(t);
  streams.openLogStream(app.logs, source);
  await Promise.resolve();
  app.flushLogs();
  viewport.setQuery('record 500');
  assert.equal(viewport.matchCount, 0);
  viewport.goEnd();
  await streams.loadLogHistory();
  assert.equal(viewport.matchCount, 1);
  assert.equal(viewport.currentMatch, null);
  assert.equal(viewport.following, true);
  assert.equal(viewport.scrollTop, viewport.maxTop);
});

test('adding a source updates existing captions without losing viewport selection', async t => {
  const { source, viewport, app, streams } = session(t);
  streams.openLogStream(app.logs, source);
  await Promise.resolve();
  app.flushLogs();
  viewport.setTop(100, false);
  const selected = viewport.records[102];
  viewport.selectedRecord = selected;
  viewport.selection = { a: { record: selected, offset: 0 }, b: { record: selected, offset: 5 } };
  await streams.changeLogSources([source, sourceOf('other')]);
  assert.match(selected.display, /^\[pod\/app\] /);
  assert.equal(viewport.entriesByRecord.get(selected).text, selected.display);
  assert.equal(viewport.selection.a.record, selected);
  assert.equal(viewport.selection.a.offset, '[pod/app] '.length);
});
