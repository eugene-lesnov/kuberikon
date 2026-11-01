import { ScrollBoxRenderable } from '@opentui/core';
import { Widgets } from './widgets.js';
import { oneLine } from './text.js';
import { t } from './i18n/index.js';

export class Dialogs extends Widgets {
  navigationHint(modal) {
    modal.navigationText = this.label(modal.dialog, '');
    modal.focusables.forEach(control => this.navigation.watch(control));
    this.navigation.refresh();
    this.refreshButtons();
  }

  showModal(title, { width = 72, height = 16 } = {}) {
    this.closeModal();
    this.cluster.cancelPodDetails();
    this.logViewport?.stopDrag();
    const layer = this.box(this.renderer.root, { position: 'absolute', top: 0, left: 0,
      width: '100%', height: '100%', zIndex: 100, justifyContent: 'center', alignItems: 'center' });
    const dialog = this.box(layer, { width: Math.min(width, this.renderer.width - 4), height,
      maxHeight: this.renderer.height - 2, border: true, borderColor: this.colors.accent,
      title, titleColor: this.colors.accent, paddingX: 1, paddingY: 0, backgroundColor: this.colors.panel, gap: 0 });
    this.modal = { layer, dialog, width, focusables: [] };
    return this.modal;
  }

  closeModal() {
    if (!this.modal) return;
    this.modal.onClose?.();
    this.cluster.cancelPodDetails();
    this.renderer.root.remove(this.modal.layer);
    this.modal.layer.destroyRecursively();
    this.modal = null;
    this.refreshButtons();
    if (!this.closing) (this.logs ? this.logViewport : this.table).focus();
  }

  cancelModal() {
    const cancel = this.modal?.cancel;
    this.closeModal();
    if (!this.closing) cancel?.();
  }

  pick(title, options, onChoose, description = '', selectedIndex = 0) {
    const textWidth = Math.max(20, Math.min(72, this.renderer.width - 4) - 6);
    const infoLines = description.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / textWidth)), 0);
    const infoHeight = description ? Math.min(8, infoLines) : 0;
    const showDescription = options.some(option => option.description);
    const listHeight = Math.max(2, options.length * (showDescription ? 2 : 1));
    const modal = this.showModal(title, { height: Math.min(this.renderer.height - 2, listHeight + infoHeight + 6) });
    let info;
    if (description) {
      info = new ScrollBoxRenderable(this.renderer, { height: infoHeight, flexShrink: 0, scrollY: true, scrollX: false });
      modal.dialog.add(info);
      this.message(info, description);
    }
    const select = this.select({ flexGrow: 1, minHeight: 2, options, selectedIndex, showDescription });
    modal.dialog.add(select);
    const buttons = this.buttonRow(modal.dialog, { footer: true });
    const cancel = this.button(buttons, t('dialog.cancel'), () => this.cancelModal());
    const apply = this.button(buttons, t('dialog.apply'), () => select.selectCurrent(), { primary: true, enabled: () => Boolean(select.getSelectedOption()) });
    select.on('itemSelected', (index, option) => { if (this.modal !== modal || this.closing) return; this.closeModal(); void this.perform(() => onChoose(option.value)); });
    modal.focusables = [...(info ? [info] : []), select, cancel, apply];
    this.navigationHint(modal);
    select.focus();
    return modal;
  }

  confirm(title, description, label, action) {
    const modal = this.showModal(title, { height: 12 });
    const scroll = new ScrollBoxRenderable(this.renderer, { flexGrow: 1, minHeight: 1, scrollY: true, scrollX: false });
    modal.dialog.add(scroll);
    this.message(scroll, description);
    const submit = () => { if (this.modal !== modal) return; this.closeModal(); return action(); };
    const buttons = this.buttonRow(modal.dialog, { footer: true });
    const cancel = this.button(buttons, t('dialog.cancel'), () => this.cancelModal());
    const apply = this.button(buttons, label, submit, { primary: true });
    modal.focusables = [scroll, cancel, apply];
    this.navigationHint(modal);
    cancel.focus();
    return modal;
  }

  inputDialog(title, label, initialValue, onSubmit, placeholder = '') {
    return this.form(title, [{ key: 'value', label, value: initialValue, placeholder }], values => onSubmit(values.value),
      { height: 13, submitLabel: t('dialog.apply') });
  }

  form(title, fields, onSubmit, { onCancel, submitLabel = t('dialog.save'), cancelLabel = t('dialog.cancel'),
    description, hint, height } = {}) {
    const fieldHeight = fields.reduce((sum, field) => sum + (field.options ? Math.min(3, field.options.length) : 1) + 2, 0);
    const formHeight = height ?? Math.min(28, Math.max(12, fieldHeight + 8 + (description ? 3 : 0) + (hint ? 3 : 0)));
    const modal = this.showModal(title, { width: 78, height: Math.min(formHeight, this.renderer.height - 2) });
    const scroll = new ScrollBoxRenderable(this.renderer, { flexGrow: 1, minHeight: 2, focusable: false, scrollY: true, scrollX: false });
    modal.dialog.add(scroll);
    modal.scroll = scroll;
    if (description) this.message(scroll, description, { marginBottom: 1 });
    modal.rows = new Map();
    const controls = new Map();
    modal.controls = controls;
    for (const field of fields) {
      const row = this.box(scroll, { height: field.options ? Math.min(3, field.options.length) + 1 : 2, flexShrink: 0, marginBottom: 1 });
      this.label(row, field.label);
      const control = field.options ? this.select({ height: Math.min(3, field.options.length),
        options: field.options.map(option => ({ description: '', ...option })), showDescription: false,
        selectedIndex: Math.max(0, field.options.findIndex(option => option.value === field.value)) }) :
        this.input({ value: String(field.value ?? ''), placeholder: field.placeholder, maxLength: field.maxLength ?? 4096 });
      row.add(control);
      controls.set(field.key, control);
      modal.rows.set(control, row);
      if (field.options) control.on('itemSelected', () => {
        if (this.modal === modal && !modal.busy && this.renderer.currentFocusedRenderable === control) {
          this.navigation.cycle(false);
        }
      });
    }
    if (hint) this.message(scroll, hint);
    const errorText = this.message(modal.dialog, '', { height: 2, error: true });
    const submit = async () => {
      if (modal.busy || this.modal !== modal || this.closing) return;
      modal.busy = true;
      this.refreshButtons();
      try {
        const values = Object.fromEntries(fields.map(field => {
          const control = controls.get(field.key);
          return [field.key, field.options ? control.getSelectedOption().value : field.trim === false ? control.value : control.value.trim()];
        }));
        await onSubmit(values);
        if (this.modal === modal) this.closeModal();
      } catch (error) { if (this.modal === modal) errorText.content = oneLine(error.message); }
      finally { modal.busy = false; this.refreshButtons(); }
    };
    const buttons = this.buttonRow(modal.dialog, { footer: true });
    modal.submit = submit;
    modal.cancel = onCancel;
    modal.focusables = [...controls.values(), this.button(buttons, cancelLabel, () => this.cancelModal()),
      this.button(buttons, submitLabel, submit, { primary: true })];
    this.navigationHint(modal);
    modal.focusables[0]?.focus();
    return modal;
  }
}
