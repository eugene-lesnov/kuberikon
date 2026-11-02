import { InputRenderable, ScrollBoxRenderable } from '@opentui/core';
import { RecordText } from './record-text.js';
import { logDetails } from './log-formatter.js';
import { oneLine } from './text.js';
import { t } from './i18n/index.js';

export function showLogDetails(app) {
  let record = app.logViewport.detailRecord;
  if (!app.logs || !record) { app.setStatus(t('logs.noRecord')); return; }
  const records = app.logViewport.entries.map(entry => entry.record);
  let recordIndex = records.indexOf(record);
  if (recordIndex < 0) { app.setStatus(t('logs.noRecord')); return; }
  app.logViewport.pause();
  app.logViewport.draw();
  app.renderer.clearSelection();
  let original = '';
  let content = '';
  let raw = false;
  const modal = app.showModal(t('logs.details'), { width: 100, height: Math.min(32, app.renderer.height - 2) });
  modal.closeOnEscape = true;
  const sourceLabel = app.label(modal.dialog, '');
  const toolbar = app.buttonRow(modal.dialog);
  const showView = showRaw => {
    raw = showRaw;
    app.renderer.clearSelection();
    readable.actionActive = !raw;
    rawView.actionActive = raw;
    app.paintButton(readable);
    app.paintButton(rawView);
    scroll.scrollTo(0);
    text.setValue(raw ? original : content);
  };
  const readable = app.button(toolbar, t('logs.readableView'), () => showView(false), { active: true });
  const rawView = app.button(toolbar, t('logs.original'), () => showView(true));
  const searchRow = app.box(toolbar, { height: 1, flexGrow: 1, flexShrink: 1, flexBasis: 52,
    minWidth: 52, maxWidth: '100%', flexDirection: 'row', gap: 1 });
  const search = app.input({ width: 'auto', flexGrow: 1, minWidth: 8, maxLength: 256, placeholder: t('logs.recordSearch') });
  searchRow.add(search);
  const matches = app.text(searchRow, '', { width: 12, flexShrink: 0, fg: app.colors.muted, wrapMode: 'none' });
  const scroll = new ScrollBoxRenderable(app.renderer, { flexGrow: 1, minHeight: 1, scrollY: true, scrollX: false });
  modal.dialog.add(scroll);
  modal.contentControl = scroll;
  const text = new RecordText(app.renderer, { value: content, colors: app.colors, scroll, onChange: () => {
    matches.visible = Boolean(text.query);
    matches.content = !text.query ? '' : text.matches.length ? t('logs.recordMatches', { current: text.matchIndex + 1, count: text.matches.length }) : t('logs.recordNoMatches');
    matches.fg = text.query && !text.matches.length ? app.colors.warn : app.colors.muted;
    app.refreshButtons();
  } });
  scroll.add(text);
  matches.visible = false;
  search.on('input', () => { app.renderer.clearSelection(); text.setQuery(search.value); });
  modal.search = search;
  modal.captureKey = key => {
    const focused = app.renderer.currentFocusedRenderable;
    const modified = key.ctrl || key.meta || key.option;
    if (!modified && !(focused instanceof InputRenderable) && ['<', '>'].includes(key.sequence)) {
      showRecord(recordIndex + (key.sequence === '<' ? -1 : 1));
      return true;
    }
    if (key.ctrl && !key.meta && !key.option && !key.shift && focused === search && ['up', 'down'].includes(key.name)) {
      text.findMatch(key.name === 'up' ? -1 : 1);
      return true;
    }
    return false;
  };
  const feedback = app.message(modal.dialog, '', { height: 2 });
  const copy = async (value, message) => {
    const copiedRecord = record;
    try {
      const result = await app.clipboard.writeText(value, { destination: 'best-available' });
      if (app.closing || app.modal !== modal || record !== copiedRecord) return;
      feedback.content = t(result.host.status === 'written' ? message : result.terminal.status === 'attempted' ? 'status.copyAttempted' : 'status.copyUnsupported');
      feedback.fg = result.host.status === 'written' ? app.colors.good : app.colors.warn;
    } catch (error) {
      if (app.closing || app.modal !== modal || record !== copiedRecord) return;
      feedback.content = oneLine(error.message);
      feedback.fg = app.colors.error;
    }
  };
  const buttons = app.buttonRow(modal.dialog, { footer: true });
  const previous = app.button(buttons, t('logs.recordPrevious'), () => showRecord(recordIndex - 1),
    { shortcut: '<', enabled: () => recordIndex > 0, skipWhenDisabled: true });
  const next = app.button(buttons, t('logs.recordNext'), () => showRecord(recordIndex + 1),
    { shortcut: '>', enabled: () => recordIndex < records.length - 1, skipWhenDisabled: true });
  const copyOriginal = app.button(buttons, t('logs.copyOriginal'), () => copy(original, 'logs.copiedOriginal'));
  const copyReadable = app.button(buttons, t('logs.copyReadable'), () => copy(content, 'logs.copiedReadable'));
  const close = app.button(buttons, t('dialog.close'), () => app.closeModal());
  const showRecord = index => {
    const candidate = records[index];
    if (!candidate) return;
    const candidateContent = logDetails(candidate.text);
    app.renderer.clearSelection();
    record = candidate;
    recordIndex = index;
    original = candidate.text;
    content = candidateContent;
    sourceLabel.content = oneLine(candidate.source.label);
    feedback.content = '';
    scroll.scrollTo(0);
    text.setValue(raw ? original : content);
    const currentIndex = app.logViewport.entries.findIndex(entry => entry.record === candidate);
    if (currentIndex >= 0 && app.logViewport.detailRecord !== candidate) app.logViewport.selectRecordAt(currentIndex);
    app.refreshButtons();
    if ((previous.focused && index === 0) || (next.focused && index === records.length - 1)) app.navigation.focus(scroll);
  };
  modal.focusables = [readable, rawView, search, scroll, previous, next, copyOriginal, copyReadable, close];
  app.navigationHint(modal);
  showRecord(recordIndex);
  scroll.focus();
}
