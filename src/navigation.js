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
      ...app.tabBoxes, ...app.resourceButtons, app.filter, app.logFilterButton, app.table, app.logViewport,
      app.directoryButton, ...app.actionButtons, ...app.keyButtons,
    ];
    return controls.filter(control => {
      if (!control || control.isDestroyed || control.skipWhenDisabled && !control.canActivate()) return false;
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
    else if (!app.modal && !app.logs && focused === app.table) {
      if (app.tab === 'favorites') key = 'navigation.favorites';
      else key = ['forwards', 'groups'].includes(app.tab) ? 'navigation.forwards' : 'navigation.resources';
    }
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

  moveButton(direction) {
    const current = this.app.renderer.currentFocusedRenderable;
    if (!this.app.uiButtons?.has(current)) return;
    const buttons = this.controls().filter(control => this.app.uiButtons.has(control) && control.parent === current.parent);
    const index = buttons.indexOf(current);
    if (index >= 0) this.focus(buttons[index + direction]);
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
    if (app.logs && !app.modal && focused === app.filter && !modified && !key.shift && ['up', 'down'].includes(key.name)) {
      consume(); app.findLogMatch(key.name === 'up' ? -1 : 1); return true;
    }
    if (['tab', 'escape'].includes(key.name)) return false;
    if (focused instanceof InputRenderable) {
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
    const name = ({ j: 'down', k: 'up' })[commandKey(key)] ?? key.name;
    if (!['up', 'down', 'left', 'right', 'pageup', 'pagedown', 'home', 'end'].includes(name)) return false;
    consume();
    if (key.shift || app.switching && !app.modal) return true;
    const direction = ['up', 'left', 'pageup', 'home'].includes(name) ? -1 : 1;
    if (focused === app.logViewport && !app.modal) {
      if (['up', 'down'].includes(name)) focused.selectRecord(direction);
      else if (name.startsWith('page')) focused.moveBy(direction * Math.max(1, focused.contentHeight - 1));
      else if (name === 'home') focused.goStart();
      else if (name === 'end') focused.goEnd();
    } else if (focused === app.table && !app.modal) {
      if (['left', 'right'].includes(name) || !app.visibleRows.length) return true;
      const index = app.visibleRows.findIndex(item => app.resourceTable.rowId(item) === app.selected[app.tab]);
      const step = name.startsWith('page') ? Math.max(1, Math.floor(focused.viewport.height) - 1) : 1;
      app.resourceTable.selectRow(name === 'home' ? 0 : name === 'end' ? app.visibleRows.length - 1 : index + direction * step);
    } else if (focused instanceof MouseSelectRenderable) {
      if (['left', 'right'].includes(name) || !focused.options.length) return true;
      const step = name.startsWith('page') ? Math.max(1, Math.floor(focused.height / (focused.showDescription ? 2 : 1)) - 1) : 1;
      const index = name === 'home' ? 0 : name === 'end' ? focused.options.length - 1 : focused.getSelectedIndex() + direction * step;
      focused.setSelectedIndex(Math.max(0, Math.min(index, focused.options.length - 1)));
    } else if (this.scrollable(focused)) {
      if (name === 'home') focused.scrollTo(0);
      else if (name === 'end') focused.scrollTo(Infinity);
      else if (['up', 'down', 'pageup', 'pagedown'].includes(name)) {
        const step = name.startsWith('page') ? Math.max(1, Math.floor(focused.viewport.height) - 1) : 1;
        focused.scrollBy(direction * step);
      } else if (focused.scrollX) focused.scrollBy({ x: direction, y: 0 });
    } else if (['left', 'right'].includes(name)) {
      this.moveButton(direction);
    }
    return true;
  }
}
