import { isAbsolute, extname } from 'node:path';
import { isIP } from 'node:net';
import { t } from './i18n/index.js';

export const validNamespace = value => typeof value === 'string' && value.length <= 63 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
export const validResourceName = value => text(value) && value.length <= 253 && /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(value);
export const isProfileFile = value => typeof value === 'string' && extname(value).toLowerCase() === '.kuber';

export function validateForward(spec) {
  if (!['service', 'pod'].includes(spec.kind) || !validResourceName(spec.name) || !validNamespace(spec.namespace)) throw new Error(t('error.target'));
  if (!/^\d+$/.test(String(spec.localPort)) || Number(spec.localPort) < 1 || Number(spec.localPort) > 65535) throw new Error(t('error.localPort'));
  if (spec.address !== 'localhost' && !isIP(spec.address)) throw new Error(t('error.address'));
  const remote = String(spec.remotePort).trim();
  if (/^\d+$/.test(remote)) {
    if (Number(remote) < 1 || Number(remote) > 65535) throw new Error(t('error.remoteRange'));
  } else if (spec.kind !== 'service' || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(remote) || !/[a-z]/.test(remote) || remote.length > 15) {
    throw new Error(t('error.remotePort'));
  }
  return { kind: spec.kind, name: spec.name, namespace: spec.namespace, localPort: Number(spec.localPort), remotePort: remote, address: spec.address };
}

export const emptySettings = () => ({ version: 6, profilesDirectory: '', logExportDirectory: '', profiles: [], forwards: [], favorites: [], groups: [] });

export const favoriteKey = favorite => JSON.stringify(['resource', favorite.target.namespace, favorite.target.kind, favorite.target.name]);

export function validateSettings(value) {
  const invalid = () => { throw new Error(t('error.settingsSchema')); };
  if (!value || value.version !== 6 || !['profiles', 'forwards', 'groups', 'favorites'].every(key => Array.isArray(value[key]) && value[key].length <= 10000)) invalid();
  const profilesDirectory = value.profilesDirectory ?? '';
  const logExportDirectory = value.logExportDirectory ?? '';
  if ([profilesDirectory, logExportDirectory].some(path => path !== '' && (!text(path) || !isAbsolute(path)))) invalid();
  const ids = new Set();
  const id = item => { if (!item || !text(item.id) || ids.has(item.id)) invalid(); ids.add(item.id); };
  const profiles = value.profiles.map(profile => {
    id(profile);
    if (profile.mode !== 'live' || !text(profile.name) || !text(profile.context) || !text(profile.file) || !isAbsolute(profile.file) || !(profile.namespace === '*' || validNamespace(profile.namespace))) invalid();
    return { id: profile.id, mode: 'live', name: profile.name, context: profile.context, file: profile.file, namespace: profile.namespace };
  });
  const forwards = value.forwards.map(forward => {
    id(forward);
    const profileId = forward.profileId;
    if (profileId !== null && !text(profileId)) invalid();
    return { id: forward.id, profileId, spec: validateForward(forward.spec ?? {}) };
  });
  const forwardIds = new Set(forwards.map(forward => forward.id));
  const favoriteKeys = new Set();
  const favorites = value.favorites.map(favorite => {
    if (favorite?.type !== 'resource') invalid();
    const target = favorite.target;
    if (!target || !['service', 'pod'].includes(target.kind) || !validResourceName(target.name) || !validNamespace(target.namespace)) invalid();
    const normalized = { type: 'resource', target: { kind: target.kind, name: target.name, namespace: target.namespace } };
    const key = favoriteKey(normalized);
    if (favoriteKeys.has(key)) return null;
    favoriteKeys.add(key);
    return normalized;
  }).filter(Boolean);
  const groups = value.groups.map(group => {
    id(group);
    if (!text(group.name) || typeof group.autostart !== 'boolean' || !Array.isArray(group.forwardIds) || group.forwardIds.length > 10000 || new Set(group.forwardIds).size !== group.forwardIds.length || !group.forwardIds.every(key => forwardIds.has(key))) invalid();
    return { id: group.id, name: group.name, forwardIds: [...group.forwardIds], autostart: group.autostart };
  });
  if (new Set(groups.map(group => group.name.toLowerCase())).size !== groups.length) invalid();
  return { version: 6, profilesDirectory, logExportDirectory, profiles, forwards, favorites, groups };
}
