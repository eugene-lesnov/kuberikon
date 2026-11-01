import { isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import { validNamespace, validResourceName, validateForward } from './config.js';
import { t } from './i18n/index.js';

const text = value => value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
const flags = {
  '--kubeconfig': value => text(value) && isAbsolute(value),
  '--context': text,
  '--namespace': validNamespace,
  '--request-timeout': value => /^\d+(ms|s|m)$/.test(value),
};
const options = {
  get: { ...flags, '--raw': value => value === '/version', '--output': value => ['json', 'wide'].includes(value), '--all-namespaces': value => value === 'true', '--selector': text,
    '--server-print': value => value === 'true', '--chunk-size': value => value === '500' },
  logs: { ...flags, '--container': validResourceName, '--follow': value => value === 'true', '--timestamps': value => value === 'true',
    '--since-time': value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)),
    '--tail': value => /^(-1|\d+)$/.test(value) && Number.isSafeInteger(Number(value)) },
  'port-forward': { ...flags, '--address': value => value === 'localhost' || Boolean(isIP(value)), '--pod-running-timeout': value => /^\d+s$/.test(value) },
};

export function assertReadOnly(args) {
  const invalid = () => { throw new Error(t('error.readOnlyCommand')); };
  if (!Array.isArray(args) || !args.length || !args.every(value => typeof value === 'string' && value.length > 0 && value.length <= 16384 && !/[\x00-\x1f\x7f]/.test(value))) invalid();
  const verb = args[0];
  if (!Object.hasOwn(options, verb)) invalid();
  const values = new Map();
  const positional = [];
  for (const arg of args.slice(1)) {
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    const separator = arg.indexOf('=');
    const name = arg.slice(0, separator);
    const value = arg.slice(separator + 1);
    if (separator < 0 || !Object.hasOwn(options[verb], name) || values.has(name) || !options[verb][name](value)) invalid();
    values.set(name, value);
  }
  if (!values.has('--kubeconfig') || !values.has('--context')) invalid();
  if (verb === 'get' && values.has('--raw')) {
    if (positional.length || [...values.keys()].some(name => !['--kubeconfig', '--context', '--request-timeout', '--raw'].includes(name))) invalid();
  } else if (verb === 'get') {
    if (positional.length !== 1) invalid();
    const resource = positional[0];
    const [kind, name, extra] = resource.split('/');
    if (values.get('--output') !== 'json' && (resource !== 'pods' || values.get('--output') !== 'wide' || values.get('--server-print') !== 'true')) invalid();
    if ((values.has('--server-print') || values.has('--chunk-size')) && (resource !== 'pods' || values.get('--output') !== 'wide')) invalid();
    if (!['pods', 'services', 'namespaces'].includes(resource) && (!['pod', 'service'].includes(kind) || !validResourceName(name) || extra !== undefined)) invalid();
    if (values.has('--all-namespaces') && (values.has('--namespace') || resource === 'namespaces' || name !== undefined)) invalid();
    if (resource !== 'namespaces' && !values.has('--namespace') && !values.has('--all-namespaces')) invalid();
  } else if (verb === 'logs') {
    if (positional.length !== 1 || !validResourceName(positional[0]) || !values.has('--namespace') || !values.has('--container')) invalid();
  } else {
    if (positional.length !== 2 || !values.has('--namespace') || !values.has('--address')) invalid();
    const [kind, name, extra] = positional[0].split('/');
    const ports = positional[1].split(':');
    if (extra !== undefined || ports.length !== 2) invalid();
    const [localPort, remotePort] = ports;
    if (localPort === '0' && values.get('--address') !== '127.0.0.1') invalid();
    validateForward({ kind, name, namespace: values.get('--namespace'), address: values.get('--address'), localPort: localPort === '0' ? 1 : localPort, remotePort });
  }
  return { file: values.get('--kubeconfig'), context: values.get('--context') };
}
