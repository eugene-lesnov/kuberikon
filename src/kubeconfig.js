import { openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseDocument } from 'yaml';
import { validNamespace, isProfileFile } from './config.js';
import { t } from './i18n/index.js';

const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
const knownFields = (object, fields) => {
  if (Object.keys(object).some(key => !fields.includes(key))) throw new Error(t('error.kubeconfigFields'));
};

export function readKubeconfig(file, requestedContext) {
  if (!text(file) || !isAbsolute(file)) throw new Error(t('error.profileFile'));
  if (!isProfileFile(file)) throw new Error(t('error.profileExtension'));
  let descriptor;
  let source;
  try {
    descriptor = openSync(file, 'r');
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error(t('error.kubeconfigSize'));
    source = readFileSync(descriptor, 'utf8');
    if (Buffer.byteLength(source) > 8 * 1024 * 1024) throw new Error(t('error.kubeconfigSize'));
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
  let config;
  try {
    const document = parseDocument(source, { schema: 'core', prettyErrors: false, uniqueKeys: true });
    if (document.errors.length || document.warnings.length) throw new Error();
    config = document.toJS({ maxAliasCount: 50 });
  } catch { throw new Error(t('error.kubeconfigParse')); }
  const named = (items, field) => {
    if (!Array.isArray(items)) throw new Error(t('error.contextReferences'));
    const entries = new Map();
    for (const item of items) {
      if (!item || !text(item.name) || entries.has(item.name) || !item[field] || typeof item[field] !== 'object' || Array.isArray(item[field])) throw new Error(t('error.contextReferences'));
      knownFields(item, ['name', field]);
      entries.set(item.name, item[field]);
    }
    return entries;
  };
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(t('error.contextReferences'));
  knownFields(config, ['apiVersion', 'kind', 'preferences', 'contexts', 'clusters', 'users', 'current-context', 'extensions']);
  const context = requestedContext ?? config['current-context'];
  if (!text(context)) throw new Error(t('error.noContext'));
  const selected = named(config.contexts, 'context').get(context);
  const clusters = named(config.clusters, 'cluster');
  const users = named(config.users, 'user');
  const cluster = clusters.get(selected?.cluster);
  const user = users.get(selected?.user);
  if (!selected || !cluster || !text(cluster.server) || !user) throw new Error(t('error.contextReferences'));
  knownFields(selected, ['cluster', 'user', 'namespace', 'extensions']);
  knownFields(cluster, ['server', 'tls-server-name', 'insecure-skip-tls-verify', 'certificate-authority', 'certificate-authority-data', 'proxy-url', 'disable-compression', 'extensions']);
  const credentials = ['client-certificate', 'client-certificate-data', 'client-key', 'client-key-data', 'token', 'tokenFile', 'username', 'password', 'as', 'as-uid', 'as-groups', 'as-user-extra', 'extensions'];
  if (Object.keys(user).some(key => !credentials.includes(key))) throw new Error(t('error.kubeconfigAuth'));
  const namespace = selected.namespace ?? 'default';
  if (!validNamespace(namespace)) throw new Error(t('error.namespace'));
  return { context, namespace };
}
