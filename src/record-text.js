import { TextRenderable, StyledText, fg, bg } from '@opentui/core';
import stringWidth from 'string-width';

export class RecordText extends TextRenderable {
  constructor(ctx, { value, colors, scroll, onChange }) {
    super(ctx, { width: '100%', content: value, fg: colors.text, selectable: true, wrapMode: 'word', flexShrink: 0 });
    this.value = value;
    this.colors = colors;
    this.scroll = scroll;
    this.onChange = onChange;
    this.query = '';
    this.matches = [];
    this.matchIndex = -1;
  }

  setValue(value) {
    this.value = value;
    this.search();
  }

  setQuery(query) {
    if (query === this.query) return;
    this.query = query;
    this.search();
  }

  search() {
    const pattern = this.query ? new RegExp(this.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu') : null;
    this.matches = pattern ? Array.from(this.value.matchAll(pattern), match => ({ start: match.index, end: match.index + match[0].length })) : [];
    this.matchIndex = this.matches.length ? 0 : -1;
    this.paintMatches();
    this.revealMatch();
    this.onChange?.();
  }

  findMatch(direction) {
    if (!this.matches.length) return;
    this.matchIndex = (this.matchIndex + direction + this.matches.length) % this.matches.length;
    this.paintMatches();
    this.revealMatch();
    this.onChange?.();
  }

  paintMatches() {
    if (!this.matches.length) { this.content = this.value; return; }
    const chunks = [];
    let offset = 0;
    for (let index = 0; index < this.matches.length; index++) {
      const match = this.matches[index];
      if (match.start > offset) chunks.push(fg(this.colors.text)(this.value.slice(offset, match.start)));
      chunks.push(bg(index === this.matchIndex ? this.colors.selected : this.colors.mark)(fg(this.colors.text)(this.value.slice(match.start, match.end))));
      offset = match.end;
    }
    if (offset < this.value.length) chunks.push(fg(this.colors.text)(this.value.slice(offset)));
    this.content = new StyledText(chunks);
  }

  revealMatch() {
    if (!this.scroll || this.pendingReveal || this.matchIndex < 0) return;
    this.pendingReveal = true;
    this.scroll.afterLayout(() => {
      this.pendingReveal = false;
      if (this.isDestroyed || this.matchIndex < 0) return;
      const offset = this.matches[this.matchIndex].start;
      const prefix = this.value.slice(0, offset);
      const line = prefix.split('\n').length - 1;
      const column = stringWidth(prefix.slice(prefix.lastIndexOf('\n') + 1));
      const { lineSources, lineStartCols } = this.lineInfo;
      let row = -1;
      for (let index = 0; index < lineSources.length; index++) {
        if (lineSources[index] > line) break;
        if (lineSources[index] === line && lineStartCols[index] <= column) row = index;
      }
      if (row >= 0) this.scroll.scrollTo(Math.max(0, row - Math.floor(this.scroll.viewport.height / 2)));
    });
  }

  onResize(width, height) {
    super.onResize(width, height);
    this.revealMatch();
  }
}
