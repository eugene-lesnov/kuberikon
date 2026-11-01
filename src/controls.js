import { InputRenderable, MouseButton, SelectRenderable } from '@opentui/core';

const russianKeys = new Map([...'йцукенгшщзхъфывапролджэячсмитьбюё'].map((letter, index) => [letter, "qwertyuiop[]asdfghjkl;'zxcvbnm,.`"[index]]));

export function commandKey(key, translate = true) {
  const value = (!key.ctrl && !key.meta && !key.option && key.sequence?.length === 1 ? key.sequence : key.name).toLowerCase();
  return translate ? russianKeys.get(value) ?? value : value;
}

export class PasswordInputRenderable extends InputRenderable {
  #characters = [];
  locked = false;

  replacePassword(start, end, text = '') {
    const characters = [...text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')]
      .slice(0, this.maxLength - this.#characters.length + end - start);
    this.#characters.splice(start, end - start, ...characters);
    this.clearSelection();
    super.value = '*'.repeat(this.#characters.length);
    this.cursorOffset = start + characters.length;
  }

  insertText(text) {
    if (this.locked) return;
    const selection = this.getSelection();
    const start = selection ? Math.min(selection.start, selection.end) : this.cursorOffset;
    const end = selection ? Math.max(selection.start, selection.end) : start;
    this.replacePassword(start, end, text);
  }

  handlePaste(event) {
    if (!this.locked) super.handlePaste(event);
  }

  handleKeyPress(key) {
    if (this.locked) return true;
    const selection = this.getSelection();
    const cursor = this.cursorOffset;
    if (['backspace', 'delete'].includes(key.name) || key.ctrl && ['h', 'd', 'u', 'k', 'w'].includes(key.name)) {
      let start = selection ? Math.min(selection.start, selection.end) : cursor;
      let end = selection ? Math.max(selection.start, selection.end) : cursor;
      if (!selection) {
        if (key.ctrl && key.name === 'u') start = 0;
        else if (key.ctrl && key.name === 'k') end = this.#characters.length;
        else if (key.ctrl && key.name === 'w') {
          while (start > 0 && /\s/u.test(this.#characters[start - 1])) start--;
          while (start > 0 && !/\s/u.test(this.#characters[start - 1])) start--;
        } else if (key.name === 'delete' || key.ctrl && key.name === 'd') end = Math.min(end + 1, this.#characters.length);
        else start = Math.max(0, start - 1);
      }
      this.replacePassword(start, end);
      return true;
    }
    if (['left', 'right', 'home', 'end'].includes(key.name) || key.ctrl && ['a', 'b', 'e', 'f'].includes(key.name)) {
      return super.handleKeyPress(key);
    }
    if (!key.ctrl && !key.meta && !key.option && !key.super && !key.hyper) {
      if (['return', 'kpenter', 'linefeed'].includes(key.name)) return this.submit();
      if (key.sequence && !/[\u0000-\u001f\u007f-\u009f]/u.test(key.sequence)) {
        this.insertText(key.sequence);
        return true;
      }
    }
    return false;
  }

  takePassword() {
    const password = Buffer.from(this.#characters.join(''), 'utf8');
    this.clearPassword();
    return password;
  }

  clearPassword() {
    this.#characters.fill('');
    this.#characters.length = 0;
    if (!this.isDestroyed) super.value = '';
  }

  destroyOwnedResources() {
    this.#characters.fill('');
    this.#characters.length = 0;
    super.destroyOwnedResources();
  }
}

export class MouseSelectRenderable extends SelectRenderable {
  constructor(renderer, { activateOnClick = false, ...options }) {
    super(renderer, options);
    this.activateOnClick = activateOnClick;
  }

  onMouseEvent(event) {
    if (event.modifiers.shift) return;
    if (event.type === 'scroll') {
      if (!['up', 'down'].includes(event.scroll?.direction)) return;
      this.focus();
      const steps = Math.max(1, Math.round(Math.abs(event.scroll.delta)));
      if (event.scroll.direction === 'up') this.moveUp(steps);
      else this.moveDown(steps);
      event.stopPropagation();
    } else if (event.button === MouseButton.LEFT && event.type === 'down') {
      this.focus();
      const lines = this.showDescription ? 2 : 1;
      const visible = Math.max(1, Math.floor(this.height / lines));
      const offset = Math.max(0, Math.min(this.getSelectedIndex() - Math.floor(visible / 2), this.options.length - visible));
      const row = Math.floor((event.y - this.y) / lines);
      const index = offset + row;
      if (row < 0 || row >= visible || index >= this.options.length) return;
      this.pressedIndex = index;
      this.setSelectedIndex(index);
      event.stopPropagation();
    } else if (event.type === 'up' && event.button === MouseButton.LEFT) {
      const pressed = this.pressedIndex;
      this.pressedIndex = null;
      if (this.activateOnClick && pressed === this.getSelectedIndex() && !event.isDragging) this.selectCurrent();
      event.stopPropagation();
    } else if (['drag', 'drag-end', 'out'].includes(event.type)) this.pressedIndex = null;
  }
}
