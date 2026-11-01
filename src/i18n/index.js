import english from './en.js';

export const locale = 'en';

export function t(key, values = {}) {
  if (!Object.hasOwn(english, key)) throw new Error(`Unknown message key: ${key}`);
  return english[key].replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match);
}
