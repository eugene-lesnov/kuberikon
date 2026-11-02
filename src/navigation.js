import { InputRenderable, ScrollBoxRenderable } from '@opentui/core';
import { commandKey, MouseSelectRenderable } from './controls.js';
import { t } from './i18n/index.js';

export class KeyboardNavigation {
  constructor(app) {
    this.app = app;
    this.watched = new WeakSet();
  }

  controls() {
    const app = this.app;
    const controls = app.modal?.focusables ?? [
      ...app.tabBoxes, app.directoryButton, ...app.resourceButtons, app.filter, app.logFilterButton,
      app.table, app.sidebar, app.logViewport, ...app.actionButtons, ...app.keyButtons,
    ];
    return controls.filter(control => {
      if (!control || control.isDestroyed || control.canActivate && !control.canActivate()) return false;
      for (let parent = control; parent; parent = parent.parent) if (!parent.visible) return false;
      return true;
    });
  }

  watch(control) {
    if (this.watched.has(control)) return;
    this.watched.add(control);
    if (this.scrollable(control) && control.border) {
      control.borderColor = this.app.colors.line;
      control.focusedBorderColor = this.app.colors.accent;
    }
    const refresh = () => {
      if (control instanceof InputRenderable) control.showCursor = control.focused;
      this.refresh();
    };
    if (control instanceof InputRenderable) control.showCursor = control.focused;
    control.on('focused', refresh);
    control.on('blurred', refresh);
  }

  isSearch(control) {
    return control instanceof InputRenderable && control === (this.app.modal?.search ?? (!this.app.modal ? this.app.filter : null));
  }

  refresh() {
    const app = this.app;
    if (app.closing) return;
    const focused = app.renderer.currentFocusedRenderable;
    let key = focused === app.logViewport ? 'navigation.logs' : focused instanceof InputRenderable ? 'navigation.field' :
      focused instanceof MouseSelectRenderable ? 'navigation.list' : this.scrollable(focused) ? 'navigation.content' : 'navigation.move';
    if (app.modal?.contentControl && focused === app.modal.contentControl) key = 'navigation.recordContent';
    else if (!app.modal && !app.logs && focused === app.table) key = 'navigation.table';
    else if (app.modal?.closeOnEscape && focused === app.modal.search) key = 'navigation.recordSearch';
    else if (app.logs && !app.modal && focused === app.filter) key = 'navigation.logSearch';
    else if (!app.modal && focused === app.filter) key = 'navigation.search';
    else if (app.logs && !app.modal && focused === app.logFilterButton) key = 'navigation.logFilter';
    const hint = app.modal?.navigationText ?? app.navigationText;
    if (hint && !hint.isDestroyed) {
      hint.content = app.modal?.navigationHint ?? t(key);
    }
  }

  scrollable(control) {
    return control instanceof ScrollBoxRenderable && control !== this.app.table;
  }

  focus(control) {
    if (!control) return;
    this.watch(control);
    control.focus();
    const modal = this.app.modal;
    if (modal?.scroll && modal.rows?.has(control)) modal.scroll.scrollChildIntoView(modal.rows.get(control));
    this.refresh();
  }

  cycle(reverse) {
    const controls = this.controls();
    controls.forEach(control => this.watch(control));
    const current = controls.indexOf(this.app.renderer.currentFocusedRenderable);
    const index = current < 0 ? reverse ? controls.length - 1 : 0 : (current + (reverse ? -1 : 1) + controls.length) % controls.length;
    this.focus(controls[index]);
  }

  moveFocus(name) {
    const app = this.app;
    const current = app.renderer.currentFocusedRenderable;
    const controls = this.controls();
    const vertical = name === 'up' || name === 'down';
    const forward = name === 'down' || name === 'right';
    const rows = app.modal?.rows;
    if (vertical && rows) {
      const fields = controls.filter(control => rows.has(control));
      const index = fields.indexOf(current);
      if (index >= 0) {
        const next = fields[index + (forward ? 1 : -1)];
        if (next) { this.focus(next); return; }
        if (!forward) return;
        const footer = controls.filter(control => !rows.has(control));
        this.focus(footer[0]);
        return;
      }
      if (!forward && fields.length && !controls.some(control => control !== current && !rows.has(control) &&
        control.y + control.height <= current.y)) {
        this.focus(fields.at(-1));
        return;
      }
    }
    if (!current || !controls.includes(current)) { this.focus(controls[0]); return; }
    const start = vertical ? current.y : current.x;
    const size = vertical ? current.height : current.width;
    const cross = vertical ? current.x : current.y;
    const crossSize = vertical ? current.width : current.height;
    const candidates = controls.filter(control => control !== current && control.width > 0 && control.height > 0).map(control => {
      const position = vertical ? control.y : control.x;
      const extent = vertical ? control.height : control.width;
      const other = vertical ? control.x : control.y;
      const otherSize = vertical ? control.width : control.height;
      const distance = forward ? position - start - size : start - position - extent;
      const gap = Math.max(0, other - cross - crossSize, cross - other - otherSize);
      const center = Math.abs(other + otherSize / 2 - cross - crossSize / 2);
      return { control, distance, score: distance + gap * 2, center };
    }).filter(candidate => candidate.distance >= 0);
    candidates.sort((a, b) => vertical ? a.distance - b.distance || a.control.x - b.control.x :
      a.score - b.score || a.center - b.center);
    const next = candidates[0]?.control ?? (!vertical ? controls[controls.indexOf(current) + (forward ? 1 : -1)] : null);
    this.focus(next);
  }

  handleKey(key) {
    const app = this.app;
    const focused = app.renderer.currentFocusedRenderable;
    const consume = () => { key.preventDefault(); key.stopPropagation(); };
    this.controls().forEach(control => this.watch(control));
    if (app.switching && !app.modal && ['up', 'down', 'left', 'right', 'pageup', 'pagedown', 'home', 'end', 'return'].includes(key.name)) {
      consume(); return true;
    }
    const search = app.modal?.search ?? (!app.modal ? app.filter : null);
    const modified = key.ctrl || key.meta || key.option;
    if (search && (key.ctrl && commandKey(key) === 'f' || !modified && !(focused instanceof InputRenderable) && key.sequence === '/')) {
      consume(); this.focus(search); return true;
    }
    if (app.logs && !app.modal && focused === app.filter && key.ctrl && ['up', 'down'].includes(key.name)) {
      consume(); app.findLogMatch(key.name === 'up' ? -1 : 1); return true;
    }
    if (['tab', 'escape'].includes(key.name)) return false;
    const name = focused instanceof InputRenderable ? key.name : ({ j: 'down', k: 'up' })[commandKey(key)] ?? key.name;
    const arrow = ['up', 'down', 'left', 'right'].includes(name);
    if (focused instanceof InputRenderable) {
      if (!modified && !key.shift && arrow) {
        const boundary = name === 'left' ? focused.cursorOffset === 0 : focused.logicalCursor.col === focused.editBuffer.getEOL().col;
        if (['up', 'down'].includes(name) || boundary && !focused.getSelection()) {
          consume(); this.moveFocus(name); return true;
        }
      }
      if (key.ctrl && commandKey(key) === 's' || /^f\d+$/.test(key.name)) return false;
      if (!modified && key.name === 'return') {
        consume();
        if (!app.modal && this.isSearch(focused)) this.focus(app.logs ? app.logViewport : app.table);
        else if (this.isSearch(focused) && app.modal?.contentControl) this.focus(app.modal.contentControl);
        else this.cycle(false);
      }
      return true;
    }
    if (modified) return false;
    if (!arrow && !['pageup', 'pagedown', 'home', 'end'].includes(name)) return false;
    consume();
    if (key.shift) return true;
    const direction = ['up', 'left', 'pageup', 'home'].includes(name) ? -1 : 1;
    if (focused === app.logViewport && !app.modal) {
      if (['up', 'down'].includes(name)) {
        const index = focused.entries.findIndex(entry => entry.record === focused.detailRecord);
        if (!focused.entries.length || index >= 0 && (index + direction < 0 || index + direction >= focused.entries.length)) this.moveFocus(name);
        else focused.selectRecord(direction);
      } else if (name.startsWith('page')) focused.moveBy(direction * Math.max(1, focused.contentHeight - 1));
      else if (name === 'home') focused.goStart();
      else if (name === 'end') focused.goEnd();
      else this.moveFocus(name);
    } else if (focused === app.table && !app.modal || focused instanceof MouseSelectRenderable) {
      const table = focused === app.table;
      const count = table ? app.visibleRows.length : focused.options.length;
      const index = table ? app.visibleRows.findIndex(item => app.resourceTable.rowId(item) === app.selected[app.tab]) : focused.getSelectedIndex();
      if (!count) {
        if (arrow) this.moveFocus(name);
      } else if (['left', 'right'].includes(name) || arrow && (index + direction < 0 || index + direction >= count)) {
        this.moveFocus(name);
      } else {
        const height = table ? focused.viewport.height : focused.height / (focused.showDescription ? 2 : 1);
        const step = name.startsWith('page') ? Math.max(1, Math.floor(height) - 1) : 1;
        const next = name === 'home' ? 0 : name === 'end' ? count - 1 : Math.max(0, Math.min(count - 1, index + direction * step));
        if (table) app.resourceTable.selectRow(next);
        else focused.setSelectedIndex(next);
      }
    } else if (this.scrollable(focused)) {
      if (name === 'home') focused.scrollTo(0);
      else if (name === 'end') focused.scrollTo(Infinity);
      else {
        const horizontal = name === 'left' || name === 'right';
        const position = horizontal ? focused.scrollLeft : focused.scrollTop;
        const maximum = horizontal ? focused.scrollWidth - focused.viewport.width : focused.scrollHeight - focused.viewport.height;
        if (arrow && (horizontal && !focused.scrollX || direction < 0 && position <= 0 || direction > 0 && position >= maximum)) this.moveFocus(name);
        else {
          const step = name.startsWith('page') ? Math.max(1, focused.viewport.height - 1) : 1;
          focused.scrollBy(horizontal ? { x: direction * step, y: 0 } : direction * step);
        }
      }
    } else if (arrow) this.moveFocus(name);
    return true;
  }
}
