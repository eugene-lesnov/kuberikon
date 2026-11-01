import { limitRecord } from './text.js';

const pick = (object, ...keys) => {
  for (const key of keys) {
    const value = Object.hasOwn(object, key) ? object[key] : key.split('.').reduce((part, field) => part != null && Object.hasOwn(Object(part), field) ? part[field] : undefined, object);
    if (value !== undefined && value !== null && value !== '') return value;
  }
};
const asText = value => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return '[nested JSON]'; }
};

function parseEvent(raw) {
  const timestamp = /^(\d{4}-\d{2}-\d{2}T\S+)\s+/.exec(raw);
  const text = (timestamp ? raw.slice(timestamp[0].length) : raw).trim();
  try {
    const entry = JSON.parse(text);
    if (entry && typeof entry === 'object') return { entry, timestamp: timestamp?.[1] };
  } catch {}
  const entry = Object.create(null);
  const pairs = /([\w.-]+)=("(?:\\.|[^"\\])*"|[^\s"]*)(?:\s+|$)/y;
  let position = 0;
  while (position < text.length) {
    pairs.lastIndex = position;
    const match = pairs.exec(text);
    if (!match || Object.hasOwn(entry, match[1])) return null;
    try { entry[match[1]] = match[2].startsWith('"') ? JSON.parse(match[2]) : match[2]; }
    catch { return null; }
    position = pairs.lastIndex;
  }
  return Object.keys(entry).length ? { entry, timestamp: timestamp?.[1] } : null;
}

function prettyJson(value) {
  const ancestors = [];
  return JSON.stringify(value, function (_key, item) {
    while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop();
    if (item && typeof item === 'object') {
      if (ancestors.length >= 8) return '[nested JSON]';
      ancestors.push(item);
    }
    return item;
  }, 2);
}

function readableJson(json) {
  const chunks = [];
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let previous = '';
  const newline = () => chunks.push('\n' + '  '.repeat(Math.min(depth, 8)));
  for (let index = 0; index < json.length; index++) {
    const char = json[index];
    if (quoted) {
      chunks.push(char);
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (/\s/u.test(char)) continue;
    if (char === '"') { quoted = true; chunks.push(char); }
    else if (char === '{' || char === '[') {
      chunks.push(char);
      depth++;
      let next = index + 1;
      while (next < json.length && /\s/u.test(json[next])) next++;
      if (!['}', ']'].includes(json[next])) newline();
    } else if (char === '}' || char === ']') {
      depth--;
      if (previous !== '{' && previous !== '[') newline();
      chunks.push(char);
    } else if (char === ',') { chunks.push(char); newline(); }
    else chunks.push(char === ':' ? ': ' : char);
    previous = char;
  }
  return chunks.join('');
}

function readableText(text) {
  const chunks = [];
  const stack = [];
  let start = 0;
  let copied = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (stack.length && char === '"') quoted = true;
    else if (char === '{' || char === '[') {
      if (!stack.length) start = index;
      stack.push(char);
    } else if (stack.length && (char === '}' || char === ']')) {
      if (stack.pop() !== (char === '}' ? '{' : '[')) { stack.length = 0; continue; }
      if (stack.length) continue;
      const json = text.slice(start, index + 1);
      try { JSON.parse(json); } catch { continue; }
      let prefix = text.slice(copied, start).replace(/[ \t]+$/u, '');
      if (copied) prefix = prefix.replace(/^[ \t]+/u, '');
      chunks.push(prefix, prefix.endsWith('\n') || copied > 0 && !prefix ? '' : '\n', readableJson(json));
      if (index + 1 < text.length && text[index + 1] !== '\n') chunks.push('\n');
      copied = index + 1;
    }
  }
  if (!copied) return text;
  const tail = text.slice(copied);
  chunks.push(tail.replace(/^[ \t]+/u, ''));
  return chunks.join('');
}

function structuredText({ entry, timestamp }) {
  if (Array.isArray(entry)) return (timestamp ? `${timestamp}\n` : '') + prettyJson(entry);
  const fields = Object.entries(entry).map(([key, value]) => {
    let text = typeof value === 'string' ? value : prettyJson(value);
    if (typeof value === 'string') text = readableText(value);
    else if (value !== null && typeof value === 'object') text = '\n' + text;
    const separator = text.startsWith('\n') ? ':' : ': ';
    return `${key}${separator}${text}`;
  });
  return [...(timestamp ? [`timestamp: ${timestamp}`] : []), ...fields].join('\n');
}

const messageFields = ['message', 'msg', '@m', 'fields.message', 'log', 'event'];
const exceptionFields = ['stack_trace', 'stackTrace', 'exception', 'throwable', 'error.stack_trace', 'exc_info'];

export function logDetails(raw) {
  const event = parseEvent(raw);
  if (!event) return limitRecord(readableText(raw));
  if (Array.isArray(event.entry)) return limitRecord(structuredText(event));
  const keys = [...new Set([
    ...messageFields.filter(key => Object.hasOwn(event.entry, key)),
    ...exceptionFields.filter(key => Object.hasOwn(event.entry, key)),
    ...Object.keys(event.entry),
  ])];
  const entry = Object.fromEntries(keys.map(key => [key, event.entry[key]]));
  return limitRecord(structuredText({ ...event, entry }));
}

export function logLevel(raw) {
  const event = parseEvent(raw);
  const value = event && !Array.isArray(event.entry) ? pick(event.entry, 'level', 'log.level', 'severity', 'levelName', 'levelname', '@l', 'lvl') : null;
  const numeric = typeof value === 'number' ? ({ 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' })[value] : null;
  return numeric ?? (value ? asText(value).toUpperCase() : /\b(TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERROR|FATAL|CRITICAL|PANIC)\b/i.exec(raw)?.[1].toUpperCase() ?? '');
}
