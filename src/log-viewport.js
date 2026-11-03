import { BoxRenderable, TextRenderable, ScrollBarRenderable, StyledText, fg, bg, MouseButton } from '@opentui/core';
import stringWidth from 'string-width';
import { t } from './i18n/index.js';
import { logLevel } from './log-formatter.js';

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
const narrowText = /^[\x20-\x7e\u0400-\u0482\u048a-\u052f]*$/u;
const literalPattern = value => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
const glyphWidth = value => value.length === 1 && narrowText.test(value) ? 1 : stringWidth(value);
const firstHit = (hits, offset) => {
  let low = 0, high = hits.length;
  while (low < high) { const middle = (low + high) >>> 1; if (hits[middle] < offset) low = middle + 1; else high = middle; }
  return low;
};

function* screenRows(text, width, wrap) {
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd);
    if (!wrap || !line.length) yield { start: lineStart, end: lineEnd, lineStart, lineEnd };
    else if (narrowText.test(line)) {
      let offset = 0;
      while (offset < line.length) {
        const end = Math.min(line.length, offset + width);
        yield { start: lineStart + offset, end: lineStart + end, lineStart, lineEnd };
        offset = end;
      }
    } else {
      let start = lineStart;
      let columns = 0;
      for (const { segment, index } of graphemes.segment(line)) {
        const size = glyphWidth(segment);
        if (columns && columns + size > width) {
          yield { start, end: lineStart + index, lineStart, lineEnd };
          start = lineStart + index;
          columns = 0;
        }
        columns += size;
      }
      yield { start, end: lineEnd, lineStart, lineEnd };
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }
}

function clippedEnd(text, start, end, width) {
  const value = text.slice(start, end);
  if (narrowText.test(value)) return Math.min(end, start + width);
  let columns = 0;
  let result = start;
  for (const { segment, index } of graphemes.segment(value)) {
    const size = glyphWidth(segment);
    if (columns + size > width) break;
    columns += size;
    result = start + index + segment.length;
  }
  return result;
}

export class LogViewport extends BoxRenderable {
  constructor(ctx, { colors, onChange, ...options }) {
    super(ctx, { flexGrow: 1, minHeight: 1, minWidth: 1, flexDirection: 'row', overflow: 'hidden', focusable: true, backgroundColor: colors.background, ...options });
    this.colors = colors;
    this.onChange = onChange;
    this.rows = [];
    this.records = [];
    this.recordSource = null;
    this.entries = [];
    this.selectedRecord = null;
    this.query = '';
    this.wrap = true;
    this.filterOnly = false;
    this.following = true;
    this.scrollTop = 0;
    this.total = 0;
    this.matchCount = 0;
    this.contentWidth = 1;
    this.contentHeight = 0;
    this.lines = new BoxRenderable(ctx, { flexGrow: 1, minWidth: 1, height: '100%', flexDirection: 'column', overflow: 'hidden', backgroundColor: colors.background });
    this.add(this.lines);
    this.bar = new ScrollBarRenderable(ctx, { orientation: 'vertical', width: 1, flexShrink: 0, height: '100%',
      visible: true, showArrows: false, onChange: position => {
        if (!this.syncingBar) { this.focus(); this.setTop(position); }
      } });
    this.add(this.bar);
    this.bar.visible = true;
    this.on('focused', () => this.draw());
    this.on('blurred', () => this.draw());
  }

  onResize() {
    if (this.pendingDraw) return;
    this.pendingDraw = setImmediate(() => {
      this.pendingDraw = null;
      if (this.isDestroyed) return;
      const width = Math.max(1, Math.floor(this.width) - 3);
      const height = Math.max(0, Math.floor(this.height));
      if (this.width < 2 || height < 1) return;
      if (width === this.contentWidth && height === this.contentHeight) return;
      const anchor = this.anchor();
      this.contentWidth = width;
      this.contentHeight = height;
      this.rebuild(anchor);
      this.onChange?.();
    });
  }

  reset() {
    this.stopDrag();
    this.records = [];
    this.recordSource = null;
    this.entries = [];
    this.entriesByRecord = new Map();
    this.allEntries = new Map();
    this.selection = null;
    this.selectedRecord = null;
    this.lastClick = null;
    this.currentMatch = null;
    this.query = '';
    this.filterOnly = false;
    this.wrap = true;
    this.following = true;
    this.scrollTop = 0;
    this.total = 0;
    this.matchCount = 0;
    this.draw();
  }

  anchor() {
    const entry = this.entryAt(this.scrollTop);
    if (!entry) return null;
    let row = 0;
    for (const span of screenRows(entry.text, entry.width, entry.wrap)) {
      if (row++ === this.scrollTop - entry.row) return { record: entry.record, offset: span.start };
    }
    return { record: entry.record, offset: 0 };
  }

  setRecords(records) {
    const last = this.records.at(-1);
    const append = this.recordSource === records && records.length >= this.records.length &&
      (!last || last.display === this.allEntries?.get(last)?.text);
    if (append && records.length === this.records.length) return;
    const anchor = this.anchor();
    const start = append ? this.records.length : 0;
    this.recordSource = records;
    this.records = [...records];
    this.rebuild(anchor, start);
  }

  rebuild(anchor = this.anchor(), start = 0) {
    const previous = this.allEntries ?? new Map();
    const shift = (point, record, delta, key = 'offset') => point?.record === record ?
      { ...point, [key]: Math.max(0, point[key] + delta) } : point;
    const allEntries = start ? previous : new Map();
    const entriesByRecord = start ? this.entriesByRecord : new Map();
    const entries = start ? this.entries : [];
    const pattern = this.query ? literalPattern(this.query) : null;
    let total = start ? this.total : 0;
    let matches = start ? this.matchCount : 0;
    for (let index = start; index < this.records.length; index++) {
      const record = this.records[index];
      const text = record.display ?? '';
      const cached = previous.get(record);
      const caption = record.caption ?? '';
      if (cached && cached.caption !== caption) {
        const prefix = value => value ? value.length + 3 : 0;
        const delta = prefix(caption) - prefix(cached.caption);
        anchor = shift(anchor, record, delta);
        if (this.selection) this.selection = { a: shift(this.selection.a, record, delta), b: shift(this.selection.b, record, delta) };
        if (this.currentMatch && !this.currentMatch.sourceOnly) this.currentMatch = shift(this.currentMatch, record, delta, 'start');
        if (this.drag?.record === record) {
          this.drag.start = Math.max(0, this.drag.start + delta);
          this.drag.end = Math.max(0, this.drag.end + delta);
        }
      }
      const geometry = cached?.text === text && cached.width === this.contentWidth && cached.wrap === this.wrap;
      let count = cached?.count ?? 0;
      if (!geometry) {
        count = 0;
        for (const _row of screenRows(text, this.contentWidth, this.wrap)) count++;
      }
      let hits = cached?.hits;
      let sourceOnly = cached?.sourceOnly;
      if (cached?.text !== text || cached.query !== this.query) {
        if (pattern) pattern.lastIndex = 0;
        hits = pattern ? Uint32Array.from(text.matchAll(pattern), match => match.index) : new Uint32Array();
        sourceOnly = Boolean(pattern && !hits.length && pattern.test(record.source.label));
      }
      const hitCount = hits.length || Number(sourceOnly);
      const entry = { record, text, width: this.contentWidth, wrap: this.wrap, query: this.query,
        hits, sourceOnly, hitCount, hit: matches, row: total, count, caption };
      allEntries.set(record, entry);
      if (this.filterOnly && this.query && !hitCount) continue;
      entriesByRecord.set(record, entry);
      entries.push(entry);
      total += count;
      matches += hitCount;
    }
    this.entries = entries;
    if (!entriesByRecord.has(this.selectedRecord)) this.selectedRecord = null;
    this.allEntries = allEntries;
    this.entriesByRecord = entriesByRecord;
    this.total = total;
    this.matchCount = matches;
    if (this.selection && (!entriesByRecord.has(this.selection.a.record) || !entriesByRecord.has(this.selection.b.record))) this.clearSelection(false);
    const selected = this.currentMatch && entriesByRecord.get(this.currentMatch.record);
    if (!selected || !(this.currentMatch.sourceOnly ? selected.sourceOnly : !selected.sourceOnly && selected.hits.includes(this.currentMatch.start))) this.currentMatch = null;
    if (this.following) this.scrollTop = this.maxTop;
    else if (anchor) {
      const entry = entriesByRecord.get(anchor.record) ?? entries.find(item => item.record.sequence > anchor.record.sequence) ?? entries.at(-1);
      this.scrollTop = entry ? entry.row + (entry.record === anchor.record ? this.rowAt(entry, anchor.offset) : 0) : 0;
    }
    this.scrollTop = Math.max(0, Math.min(this.maxTop, this.scrollTop));
    this.draw();
  }

  get detailRecord() {
    return this.selectedRecord;
  }

  selectRecord(direction) {
    if (!this.entries.length) return;
    const current = this.entriesByRecord.get(this.detailRecord);
    const index = Math.max(0, Math.min(this.entries.length - 1, this.entries.indexOf(current) + direction));
    this.selectRecordAt(index);
  }

  selectRecordAt(index) {
    const entry = this.entries[index];
    if (!entry) return;
    this.following = false;
    this.currentMatch = null;
    this.selectedRecord = entry.record;
    if (entry.row < this.scrollTop || entry.row >= this.scrollTop + this.contentHeight) {
      this.scrollTop = Math.min(this.maxTop, entry.row);
    }
    this.draw();
    this.onChange?.();
  }

  get maxTop() { return Math.max(0, this.total - this.contentHeight); }
  get emptyRows() { return Math.max(0, this.contentHeight - this.total); }

  entryIndexAt(row) {
    let low = 0;
    let high = this.entries.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.entries[middle].row <= row) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  entryAt(row) { return this.entries[this.entryIndexAt(row)]; }

  rowAt(entry, offset) {
    let index = 0;
    for (const span of screenRows(entry.text, entry.width, entry.wrap)) {
      if (offset < span.end || offset === span.end && (span.end === entry.text.length || entry.text[span.end] === '\n')) return index;
      index++;
    }
    return Math.max(0, entry.count - 1);
  }

  setTop(value, followEnd = true) {
    this.selectedRecord = null;
    this.currentMatch = null;
    this.scrollTop = Math.max(0, Math.min(this.maxTop, Math.round(value)));
    this.following = followEnd && this.scrollTop === this.maxTop;
    this.draw();
    this.onChange?.();
  }

  moveBy(delta, followEnd = true) { this.setTop(this.scrollTop + delta, followEnd && delta >= 0); }
  goStart() { this.setTop(0, false); }
  goEnd() { this.selectedRecord = null; this.currentMatch = null; this.following = true; this.scrollTop = this.maxTop; this.draw(); this.onChange?.(); }
  pause() { this.following = false; this.onChange?.(); }
  toggleFollow() { if (this.following) this.pause(); else this.goEnd(); }

  setWrap(value) {
    if (this.wrap === value) return;
    const anchor = this.anchor();
    this.wrap = value;
    this.rebuild(anchor);
    this.onChange?.();
  }

  setQuery(value) {
    if (this.query === value) return;
    this.query = value;
    this.currentMatch = null;
    if (value) this.following = false;
    this.rebuild();
    if (this.query) this.findMatch(1, true);
    this.onChange?.();
  }

  toggleFilter() {
    this.filterOnly = !this.filterOnly;
    this.rebuild();
    if (this.currentMatch) this.showMatch();
    this.onChange?.();
  }

  get matchIndex() {
    if (!this.currentMatch) return 0;
    const entry = this.entriesByRecord?.get(this.currentMatch.record);
    if (!entry) return 0;
    return entry.hit + (entry.sourceOnly ? 0 : entry.hits.indexOf(this.currentMatch.start)) + 1;
  }

  findMatch(direction = 1, nearest = false) {
    if (!this.matchCount) { this.currentMatch = null; this.draw(); this.onChange?.(); return false; }
    let index;
    if (nearest || !this.currentMatch) {
      const selected = !nearest && this.entriesByRecord.get(this.selectedRecord);
      const row = selected ? Math.max(selected.row, this.scrollTop) :
        Math.max(0, this.scrollTop + Math.floor(this.contentHeight / 2) - this.emptyRows);
      const entry = selected || this.entryAt(row);
      let within = direction < 0 ? entry.hitCount : 0;
      if (!entry.sourceOnly) {
        let offset = 0;
        let currentRow = entry.row;
        for (const span of screenRows(entry.text, entry.width, entry.wrap)) {
          offset = direction < 0 ? span.end : span.start;
          if (currentRow++ >= row) break;
        }
        within = firstHit(entry.hits, offset);
      }
      index = (entry.hit + within - (direction < 0 ? 1 : 0) + this.matchCount) % this.matchCount;
    } else index = (this.matchIndex - 1 + direction + this.matchCount) % this.matchCount;
    const entry = this.entries.find(item => item.hit <= index && item.hit + item.hitCount > index);
    this.selectedRecord = entry.record;
    this.currentMatch = { record: entry.record, start: entry.sourceOnly ? 0 : entry.hits[index - entry.hit], sourceOnly: entry.sourceOnly };
    this.following = false;
    this.showMatch();
    this.onChange?.();
    return true;
  }

  showMatch() {
    const entry = this.entriesByRecord.get(this.currentMatch.record);
    const row = entry.row + this.rowAt(entry, this.currentMatch.start);
    const relative = row - this.scrollTop + this.emptyRows;
    const center = (this.contentHeight - 1) / 2;
    if (relative < 0 || relative >= this.contentHeight || Math.abs(relative - center) > this.contentHeight * 0.3) {
      this.scrollTop = Math.max(0, Math.min(this.maxTop, Math.round(row - center)));
    }
    this.draw();
  }

  visibleRows() {
    const visible = [];
    for (let index = this.entryIndexAt(this.scrollTop); index < this.entries.length; index++) {
      const entry = this.entries[index];
      if (entry.row >= this.scrollTop + this.contentHeight) break;
      let row = entry.row;
      for (const span of screenRows(entry.text, entry.width, entry.wrap)) {
        if (row >= this.scrollTop + this.contentHeight) break;
        if (row >= this.scrollTop) visible.push({ ...span, entry, y: row - this.scrollTop + this.emptyRows });
        row++;
      }
    }
    return visible;
  }

  selectionRange() {
    if (!this.selection) return null;
    const a = this.entriesByRecord.get(this.selection.a.record);
    const b = this.entriesByRecord.get(this.selection.b.record);
    if (!a || !b) return null;
    const forward = a.row < b.row || a === b && this.selection.a.offset <= this.selection.b.offset;
    return forward ? this.selection : { a: this.selection.b, b: this.selection.a };
  }

  getSelectedText() {
    const range = this.selectionRange();
    if (!range) return '';
    const a = this.entriesByRecord.get(range.a.record);
    const b = this.entriesByRecord.get(range.b.record);
    return this.entries.filter(entry => entry.row >= a.row && entry.row <= b.row).map(entry =>
      entry.text.slice(entry === a ? range.a.offset : 0, entry === b ? range.b.offset : entry.text.length)).join('\n');
  }

  hasSelection() { return Boolean(this.selection && (this.selection.a.record !== this.selection.b.record || this.selection.a.offset !== this.selection.b.offset)); }

  clearSelection(redraw = true) {
    this.selection = null;
    this.lastClick = null;
    this.stopDrag();
    if (redraw) { this.draw(); this.onChange?.(); }
  }

  pointAt(x, y, clamp = false) {
    if (!this.entries.length) return null;
    let row = Math.floor(y - this.y) - this.emptyRows + this.scrollTop;
    if (!clamp && (row < 0 || row >= this.total)) return null;
    row = Math.max(0, Math.min(this.total - 1, row));
    const entry = this.entryAt(row);
    let index = entry.row;
    for (const span of screenRows(entry.text, entry.width, entry.wrap)) {
      if (index++ !== row) continue;
      const column = Math.max(0, Math.min(this.contentWidth - 1, Math.floor(x - this.x) - 2));
      let cells = 0;
      for (const { segment, index: offset } of graphemes.segment(entry.text.slice(span.start, span.end))) {
        const size = glyphWidth(segment);
        if (cells + size > column) return { record: entry.record, offset: span.start + offset, end: span.start + offset + segment.length, span };
        cells += size;
      }
      return { record: entry.record, offset: span.end, end: span.end, span };
    }
    return null;
  }

  onMouseEvent(event) {
    if (event.modifiers.shift) return;
    if (event.type === 'scroll') {
      if (!['up', 'down'].includes(event.scroll?.direction)) return;
      this.focus();
      this.moveBy((event.scroll.direction === 'up' ? -1 : 1) * Math.max(1, Math.round(Math.abs(event.scroll.delta))) * 3);
      event.stopPropagation();
      return;
    }
    if (event.type === 'down' && event.button === MouseButton.LEFT && event.x < this.x + this.contentWidth + 2) {
      const point = this.pointAt(event.x, event.y);
      if (!point) { this.clearSelection(); return; }
      this.focus();
      this.pause();
      this.selectedRecord = point.record;
      this.currentMatch = null;
      const now = Date.now();
      const clicks = this.lastClick && now - this.lastClick.at < 450 && this.lastClick.x === event.x && this.lastClick.y === event.y ? this.lastClick.count % 3 + 1 : 1;
      this.lastClick = { at: now, x: event.x, y: event.y, count: clicks };
      let start = point.offset;
      let end = point.offset;
      const text = this.entriesByRecord.get(point.record).text;
      if (clicks === 2) {
        const token = char => char && !/[\s,;()\[\]{}"'<>|=]/u.test(char);
        end = point.end;
        while (start > point.span.lineStart && token(text[start - 1])) start--;
        while (end < point.span.lineEnd && token(text[end])) end++;
      } else if (clicks === 3) { start = point.span.lineStart; end = point.span.lineEnd; }
      this.selection = { a: { record: point.record, offset: start }, b: { record: point.record, offset: end } };
      this.drag = { clicks, x: event.x, y: event.y, record: point.record, start, end: clicks > 1 ? end : point.end };
      this.draw();
      this.onChange?.();
      event.stopPropagation();
    } else if (event.type === 'drag' && this.drag) {
      this.drag.x = event.x; this.drag.y = event.y;
      this.drag.moved = true;
      this.extendSelection(event.x, event.y);
      this.startAutoScroll();
      event.stopPropagation();
    } else if (['up', 'drag-end'].includes(event.type) && this.drag) {
      if (!this.drag.moved && this.drag.clicks === 1) this.selection = null;
      this.stopDrag();
      this.draw();
      this.onChange?.();
      event.stopPropagation();
    }
  }

  extendSelection(x, y) {
    const point = this.pointAt(x, y, true);
    if (!point || !this.selection || !this.drag) return;
    const a = this.entriesByRecord.get(this.drag.record);
    const b = this.entriesByRecord.get(point.record);
    const forward = b.row > a.row || b === a && point.offset >= this.drag.start;
    this.selection = { a: { record: this.drag.record, offset: forward ? this.drag.start : this.drag.end },
      b: { record: point.record, offset: forward ? point.end : point.offset } };
    this.draw();
    this.onChange?.();
  }

  startAutoScroll() {
    if (this.dragTimer) return;
    this.dragTimer = setInterval(() => {
      if (!this.drag || this.isDestroyed) { this.stopDrag(); return; }
      const direction = this.drag.y < this.y + 1 ? -1 : this.drag.y >= this.y + this.contentHeight - 1 ? 1 : 0;
      if (!direction) return;
      this.moveBy(direction, false);
      this.extendSelection(this.drag.x, this.drag.y);
    }, 70);
  }

  stopDrag() { clearInterval(this.dragTimer); this.dragTimer = null; this.drag = null; }

  draw() {
    if (!this.lines || this.isDestroyed || !this.contentHeight) return;
    if (this.following) this.selectedRecord = this.entries.at(-1)?.record ?? null;
    else {
      const selected = this.entriesByRecord?.get(this.selectedRecord);
      if (!selected || selected.row + selected.count <= this.scrollTop || selected.row >= this.scrollTop + this.contentHeight) {
        this.selectedRecord = this.entryAt(this.scrollTop)?.record ?? null;
      }
    }
    while (this.rows.length > this.contentHeight) {
      const row = this.rows.pop(); this.lines.remove(row); row.destroyRecursively();
    }
    while (this.rows.length < this.contentHeight) {
      const row = new TextRenderable(this.ctx, { width: '100%', height: 1, flexShrink: 0, selectable: false, wrapMode: 'none', fg: this.colors.muted, content: '' });
      this.lines.add(row); this.rows.push(row);
    }
    const visible = new Map(this.visibleRows().map(row => [row.y, row]));
    const range = this.selectionRange();
    const a = range && this.entriesByRecord.get(range.a.record);
    const b = range && this.entriesByRecord.get(range.b.record);
    for (let y = 0; y < this.rows.length; y++) {
      const row = visible.get(y);
      this.rows[y].bg = row?.entry.record === this.selectedRecord ? this.focused ? this.colors.selected : this.colors.input :
        row?.entry.sourceOnly && row.entry.record === this.currentMatch?.record ? this.colors.mark : this.colors.background;
      if (!row) {
        const empty = this.query && this.filterOnly ? this.searchMessage ?? t('logs.noMatches') : this.emptyMessage ?? t('logs.empty');
        this.rows[y].content = !this.entries.length && y === Math.min(1, this.rows.length - 1) ? empty : '';
        continue;
      }
      const { entry, start } = row;
      let end = row.end;
      let ellipsis = false;
      if (!this.wrap) {
        const clipped = clippedEnd(entry.text, start, end, this.contentWidth);
        if (clipped < end) { end = clippedEnd(entry.text, start, end, this.contentWidth - 1); ellipsis = true; }
      }
      const level = entry.record.level ??= logLevel(entry.record.text);
      const color = entry.record.error || /ERROR|FATAL|CRITICAL|PANIC/.test(level) ? this.colors.error : /WARN/.test(level) ? this.colors.warn : /DEBUG|TRACE/.test(level) ? this.colors.muted : this.colors.text;
      const marks = [];
      for (let hit = firstHit(entry.hits, start - this.query.length + 1); hit < entry.hits.length; hit++) {
        const offset = entry.hits[hit];
        if (offset >= end) break;
        if (offset + this.query.length > start) marks.push({ from: offset, to: offset + this.query.length,
          color: this.currentMatch?.record === entry.record && this.currentMatch.start === offset ? this.colors.selected : this.colors.mark, priority: 1 });
      }
      if (range && entry.row >= a.row && entry.row <= b.row) marks.push({ from: entry === a ? range.a.offset : 0,
        to: entry === b ? range.b.offset : entry.text.length, color: this.colors.selected, priority: 2 });
      const cuts = [...new Set([start, end, ...marks.flatMap(mark => [Math.max(start, Math.min(end, mark.from)), Math.max(start, Math.min(end, mark.to))])])].sort((left, right) => left - right);
      const cursor = entry.record === this.selectedRecord && (y === 0 || visible.get(y - 1)?.entry !== entry);
      const chunks = [fg(this.colors.accent)(cursor ? '▶ ' : entry.record === this.selectedRecord ? '┃ ' : '  ')];
      for (let index = 0; index + 1 < cuts.length; index++) {
        const from = cuts[index], to = cuts[index + 1];
        if (from === to) continue;
        const mark = marks.filter(item => item.from <= from && item.to >= to).sort((left, right) => right.priority - left.priority)[0];
        chunks.push(mark ? bg(mark.color)(fg(color)(entry.text.slice(from, to))) : fg(color)(entry.text.slice(from, to)));
      }
      if (ellipsis) chunks.push(fg(color)('…'));
      this.rows[y].content = new StyledText(chunks);
    }
    this.syncingBar = true;
    try {
      this.bar.scrollSize = Math.max(this.total, this.contentHeight);
      this.bar.viewportSize = this.contentHeight;
      this.bar.scrollPosition = this.scrollTop;
    } finally { this.syncingBar = false; }
  }

  destroyOwnedResources() { this.stopDrag(); clearImmediate(this.pendingDraw); super.destroyOwnedResources(); }
}
