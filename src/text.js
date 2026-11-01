import stringWidth from 'string-width';
import { stripVTControlCharacters } from 'node:util';
import { t } from './i18n/index.js';

const segments = new Intl.Segmenter('en', { granularity: 'grapheme' });
export const clean = value => stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\t/g, '  ');
export const oneLine = value => clean(value).replace(/[\r\n]+/g, ' ');
export const hostLabel = address => address.includes(':') ? `[${address}]` : address;

export function age(value, now = Date.now()) {
  const created = Date.parse(value);
  if (!Number.isFinite(created)) return '—';
  const seconds = Math.max(0, Math.floor((now - created) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

export function limitRecord(value) {
  const text = clean(value);
  const bytes = Buffer.from(text);
  if (bytes.length <= 65536) return text;
  return new TextDecoder().decode(bytes.subarray(0, 65536), { stream: true }) + ` … [${t('error.truncatedRecord')}]`;
}

export function cell(value, width) {
  const text = oneLine(value);
  if (width < 1) return '';
  const textWidth = stringWidth(text);
  if (textWidth <= width) return text + ' '.repeat(width - textWidth);
  let result = '';
  let used = 0;
  for (const { segment } of segments.segment(text)) {
    const size = stringWidth(segment);
    if (used + size > width - 1) break;
    result += segment;
    used += size;
  }
  return result + '…' + ' '.repeat(Math.max(0, width - used - 1));
}

export function fitColumns(definitions, rows, availableWidth) {
  const columns = definitions.map(([name, , get]) => [name,
    rows.reduce((width, row) => Math.max(width, stringWidth(oneLine(get(row)))), stringWidth(name)), get]);
  let excess = columns.reduce((sum, column) => sum + column[1], columns.length - 1) - availableWidth;
  const order = definitions.map(([, , , priority = 0], index) => ({ index, priority }))
    .sort((left, right) => right.priority - left.priority);
  for (const { index } of order) {
    const minimum = Math.min(columns[index][1], Math.max(stringWidth(columns[index][0]), definitions[index][1]));
    const reduction = Math.min(Math.max(0, excess), columns[index][1] - minimum);
    columns[index][1] -= reduction;
    excess -= reduction;
  }
  for (const { index } of order) {
    if (excess <= 0) break;
    const reduction = Math.min(excess, columns[index][1] - 1);
    columns[index][1] -= reduction;
    excess -= reduction;
  }
  return columns;
}

export const statusLabel = value => ['stopped', 'starting', 'running', 'retrying', 'stopping', 'error'].includes(value) ? t(`status.${value}`) : value;
