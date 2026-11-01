import { BoxRenderable, TextRenderable, InputRenderable, MouseButton, StyledText, fg, bold, underline } from '@opentui/core';
import stringWidth from 'string-width';
import { MouseSelectRenderable, PasswordInputRenderable } from './controls.js';
import { oneLine } from './text.js';

export class Widgets {
  box(parent, options = {}) {
    const box = new BoxRenderable(this.renderer, { flexDirection: 'column', ...options });
    parent.add(box);
    if (options.focusable) this.navigation?.watch(box);
    return box;
  }

  text(parent, content = '', options = {}) {
    const text = new TextRenderable(this.renderer, { content, fg: this.colors.text, selectable: false, ...options });
    parent.add(text);
    return text;
  }

  label(parent, content) {
    return this.text(parent, content, { height: 1, flexShrink: 0, fg: this.colors.muted, wrapMode: 'none', truncate: true });
  }

  message(parent, content = '', { error = false, ...options } = {}) {
    return this.text(parent, content, { width: '100%', flexShrink: 0, wrapMode: 'word',
      fg: error ? this.colors.error : this.colors.muted, ...options });
  }

  input({ password = false, ...options } = {}) {
    const Input = password ? PasswordInputRenderable : InputRenderable;
    const input = new Input(this.renderer, { width: '100%', height: 1, flexShrink: 0,
      backgroundColor: this.colors.input, focusedBackgroundColor: this.colors.selected,
      textColor: this.colors.text, focusedTextColor: this.colors.text, placeholderColor: this.colors.muted,
      ...options, onMouseDown: event => {
        if (event.button !== MouseButton.LEFT) return;
        input.focus();
      } });
    this.navigation.watch(input);
    return input;
  }

  select(options = {}) {
    const select = new MouseSelectRenderable(this.renderer, { width: '100%', minHeight: 1, flexShrink: 0,
      backgroundColor: this.colors.panel, focusedBackgroundColor: this.colors.panel,
      textColor: this.colors.text, focusedTextColor: this.colors.text, descriptionColor: this.colors.muted,
      selectedBackgroundColor: this.colors.input, selectedTextColor: this.colors.text,
      selectedDescriptionColor: this.colors.muted, showDescription: false, showScrollIndicator: true,
      activateOnClick: true, ...options });
    select.on('focused', () => { select.selectedBackgroundColor = this.colors.selected; });
    select.on('blurred', () => { select.selectedBackgroundColor = this.colors.input; });
    select.on('selectionChanged', () => this.refreshButtons());
    this.navigation.watch(select);
    return select;
  }

  buttonRow(parent, { footer = false, ...options } = {}) {
    return this.box(parent, { height: 'auto', minHeight: 1, flexShrink: 0, width: '100%',
      flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, rowGap: 0,
      justifyContent: footer ? 'flex-end' : 'flex-start', marginTop: footer ? 1 : 0, ...options });
  }

  button(parent, label, action, { shortcut = '', primary = false, active = false,
    backgroundColor = this.colors.panel, enabled, allowWhileBusy = false, skipWhenDisabled = false, width } = {}) {
    let owner = parent;
    while (owner && owner !== this.modal?.dialog) owner = owner.parent;
    const modal = owner ? this.modal : null;
    let pressed = false;
    const canActivate = () => !this.closing && (!modal || this.modal === modal && (!modal.busy || allowWhileBusy)) && (!enabled || enabled());
    const activate = () => { if (canActivate()) void this.perform(action); };
    const button = this.box(parent, { height: 1, minWidth: 1, maxWidth: '100%', flexShrink: 0, focusable: true,
      onMouseOver: () => {
        button.hovered = true;
        this.paintButton(button);
      }, onMouseDown: event => {
        if (event.button !== MouseButton.LEFT) return;
        pressed = canActivate();
        if (skipWhenDisabled && !pressed) { event.stopPropagation(); return; }
        button.focus();
        event.stopPropagation();
      }, onMouseOut: () => {
        pressed = false;
        button.hovered = false;
        this.paintButton(button);
      }, onMouseUp: event => {
        if (event.button !== MouseButton.LEFT) return;
        const clicked = pressed && !event.isDragging;
        pressed = false;
        if (clicked) activate();
        event.stopPropagation();
      }, onKeyDown: key => {
        if (['return', 'space'].includes(key.name)) { key.preventDefault(); key.stopPropagation(); activate(); }
      } });
    this.text(button, '', { width: '100%', height: 1, truncate: true, wrapMode: 'none' });
    Object.assign(button, { shortcut, primary, actionActive: active, surface: backgroundColor, canActivate, skipWhenDisabled, fixedWidth: width });
    this.setActionLabel(button, label);
    button.on('focused', () => this.paintButton(button));
    button.on('blurred', () => this.paintButton(button));
    this.uiButtons ??= new Set();
    this.uiButtons.add(button);
    button.on('destroyed', () => this.uiButtons.delete(button));
    return button;
  }

  setActionLabel(button, label) {
    const value = oneLine(label);
    if (button.buttonLabel === value) { this.paintButton(button); return; }
    button.buttonLabel = value;
    const key = button.shortcut;
    const index = /^[a-z]$/i.test(key) ? button.buttonLabel.toLowerCase().indexOf(key.toLowerCase()) : -1;
    button.labelIndex = index;
    button.labelPrefix = key && index < 0 ? `${key} ` : '';
    button.width = button.fixedWidth ?? stringWidth(button.labelPrefix + button.buttonLabel) + 2;
    button.buttonState = null;
    this.paintButton(button);
  }

  paintButton(button) {
    if (button.isDestroyed) return;
    const text = button.getChildren()[0];
    if (!text || text.isDestroyed) return;
    const enabled = button.canActivate();
    const hovered = enabled && button.hovered;
    const state = `${enabled}:${button.focused}:${hovered}:${button.actionActive}:${button.primary}`;
    if (button.buttonState === state) return;
    button.buttonState = state;
    button.backgroundColor = button.focused ? this.colors.selected : hovered || button.actionActive ? this.colors.input : button.surface;
    const color = enabled ? button.primary || button.actionActive ? this.colors.accent : this.colors.text : this.colors.muted;
    const accent = enabled ? this.colors.accent : this.colors.muted;
    const label = button.buttonLabel;
    const index = button.labelIndex;
    const chunks = index >= 0 ? [
      fg(color)(` ${label.slice(0, index)}`), fg(accent)(bold(label[index])), fg(color)(`${label.slice(index + 1)} `),
    ] : [fg(accent)(bold(` ${button.labelPrefix}`)), fg(color)(`${label} `)];
    text.content = new StyledText(button.focused ? chunks.map(chunk => underline(chunk)) : chunks);
  }

  refreshButtons() {
    for (const button of this.uiButtons ?? []) if (!button.isDestroyed) this.paintButton(button);
  }
}
