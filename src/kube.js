import { basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { t } from './i18n/index.js';
import { validNamespace, validResourceName, isProfileFile } from './config.js';
import { readKubeconfig } from './kubeconfig.js';
import { initialLogLines } from './logs.js';

export const expandPath = value => resolve(value.replace(/^~(?=\/|$)/, homedir()));
export const fileProfile = file => ({ name: basename(file).replace(/\.[^.]+$/, '') || basename(file), file: expandPath(file), mode: 'live' });

export async function discoverProfiles(directory) {
  const folder = expandPath(directory);
  const entries = await readdir(folder, { withFileTypes: true });
  return entries.filter(entry => entry.isFile() && !entry.name.startsWith('.') && isProfileFile(entry.name))
    .map(entry => fileProfile(resolve(folder, entry.name))).sort((left, right) => left.name.localeCompare(right.name));
}

const portsOf = items => items.filter(port => (port.protocol ?? 'TCP') === 'TCP')
  .map(port => ({ name: port.name ?? '', port: port.port ?? port.containerPort }));

function podSummary(pod) {
  const containers = pod.spec.containers ?? [];
  const statuses = pod.status?.containerStatuses ?? [];
  const waiting = statuses.find(status => status.state?.waiting?.reason);
  const terminated = statuses.find(status => status.state?.terminated?.exitCode && status.state.terminated.reason);
  const initStatuses = pod.status?.initContainerStatuses ?? [];
  const init = (pod.spec.initContainers ?? []).find(container => {
    const state = initStatuses.find(status => status.name === container.name);
    return container.restartPolicy === 'Always' ? !state?.started : state?.state?.terminated?.exitCode !== 0;
  });
  const initState = initStatuses.find(status => status.name === init?.name)?.state;
  const initReason = init ? `Init:${initState?.waiting?.reason ?? initState?.terminated?.reason ?? 'Pending'}` : null;
  const phase = pod.status?.phase ?? 'Unknown';
  const completed = phase === 'Succeeded' ? 'Completed' : phase === 'Failed' ? pod.status.reason ?? terminated?.state.terminated.reason ?? phase : null;
  const preferred = pod.metadata.annotations?.['kubectl.kubernetes.io/default-container'];
  return {
    compact: false,
    id: `pod:${pod.metadata.namespace}/${pod.metadata.name}`, kind: 'pod', name: pod.metadata.name,
    namespace: pod.metadata.namespace, uid: pod.metadata.uid, createdAt: pod.metadata.creationTimestamp, labels: { ...pod.metadata.labels },
    node: pod.spec.nodeName ?? '', ips: (pod.status?.podIPs ?? []).map(item => item.ip).filter(Boolean), ip: pod.status?.podIP ?? '',
    status: pod.metadata.deletionTimestamp ? 'Terminating' : completed ?? initReason ?? waiting?.state.waiting.reason ?? terminated?.state.terminated.reason ?? pod.status?.reason ?? phase,
    ready: `${statuses.filter(status => status.ready).length}/${containers.length}`,
    restarts: [...statuses, ...initStatuses].reduce((sum, status) => sum + (status.restartCount ?? 0), 0),
    containers: containers.map(container => container.name),
    terminalContainers: statuses.filter(status => status.state?.terminated && (['Succeeded', 'Failed'].includes(phase) ||
      pod.spec.restartPolicy === 'Never' || pod.spec.restartPolicy === 'OnFailure' && status.state.terminated.exitCode === 0)).map(status => status.name),
    defaultContainer: containers.some(container => container.name === preferred) ? preferred :
      containers.find(container => !/^(istio-proxy|linkerd-proxy|envoy.*|vault-agent.*)$/.test(container.name))?.name ?? containers[0]?.name,
    ports: portsOf(containers.flatMap(container => container.ports ?? [])),
  };
}

function podTable(text, namespace) {
  const result = [];
  let columns;
  const required = ['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE', ...(namespace === '*' ? ['NAMESPACE'] : [])];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.trim().split(/\s{2,}/);
    if (required.every(name => cells.includes(name))) { columns = cells; continue; }
    if (!columns) throw new Error(t('error.podTable'));
    const cell = name => cells[columns.indexOf(name)] ?? '';
    const name = cell('NAME');
    const scope = namespace === '*' ? cell('NAMESPACE') : namespace;
    if (cells.length !== columns.length || !validResourceName(name) || !validNamespace(scope) ||
      !/^\d+\/\d+$/.test(cell('READY')) || !/^\d+(?:\s|$)/.test(cell('RESTARTS')) || !cell('STATUS') || !cell('AGE')) {
      throw new Error(t('error.podTable'));
    }
    result.push({ id: `pod:${scope}/${name}`, kind: 'pod', name, namespace: scope, compact: true,
      ready: cell('READY'), status: cell('STATUS'), restarts: Number.parseInt(cell('RESTARTS'), 10),
      ageText: cell('AGE'), containers: [], ports: [] });
  }
  return result;
}

export class KubeBackend {
  constructor(pool, privileged) {
    this.pool = pool;
    this.privileged = privileged;
    this.details = new Map();
    this.serviceLists = new Map();
  }

  args(profile) { return [`--kubeconfig=${profile.file}`, `--context=${profile.context}`]; }

  resourceKey(profile, target) { return JSON.stringify([profile.file, profile.context, target.namespace, target.kind, target.name]); }

  clearCache() { this.details.clear(); this.serviceLists.clear(); }

  remember(cache, key, value) {
    cache.delete(key);
    cache.set(key, { at: Date.now(), value });
    while (cache.size > 128) cache.delete(cache.keys().next().value);
    return value;
  }

  async resolveProfile(candidate, signal) {
    if (signal?.aborted) throw new DOMException(t('error.requestCancelled'), 'AbortError');
    const file = expandPath(candidate.file);
    let config;
    try {
      config = readKubeconfig(file, candidate.context);
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error(t('error.kubeconfig', { reason: error.message }));
    }
    const { context } = config;
    const namespace = candidate.namespace ?? config.namespace;
    if (namespace !== '*' && !validNamespace(namespace)) throw new Error(t('error.namespace'));
    return { ...candidate, file, id: candidate.id ?? randomUUID(), context, namespace, mode: 'live' };
  }

  async namespaces(profile, signal) {
    const result = JSON.parse(await this.pool.run(['get', ...this.args(profile), '--request-timeout=20s', 'namespaces', '--output=json'], { signal }));
    return result.items.map(item => item.metadata.name).sort();
  }

  async list(profile, namespace, kind, signal) {
    const scope = namespace === '*' ? ['--all-namespaces=true'] : [`--namespace=${namespace}`];
    if (kind === 'pod') return this.podList(profile, namespace, signal);
    const result = JSON.parse(await this.pool.run(['get', ...this.args(profile), '--request-timeout=20s', 'services', ...scope, '--output=json'], { signal }));
    return this.remember(this.serviceLists, JSON.stringify([profile.file, profile.context, namespace]), result.items.map(service => ({
      id: `service:${service.metadata.namespace}/${service.metadata.name}`, kind: 'service',
      name: service.metadata.name, namespace: service.metadata.namespace,
      status: service.spec.type, ready: '—', ports: portsOf(service.spec.ports ?? []), selector: service.spec.selector ?? {},
    })));
  }

  async podList(profile, namespace, signal, selector) {
    const scope = namespace === '*' ? ['--all-namespaces=true'] : [`--namespace=${namespace}`];
    const text = await this.pool.run(['get', ...this.args(profile), '--request-timeout=30s', 'pods', ...scope,
      '--output=wide', '--server-print=true', '--chunk-size=500', ...(selector ? [`--selector=${selector}`] : [])], { signal, timeout: 90000 });
    return podTable(text, namespace);
  }

  async podsFor(profile, service, signal) {
    const selector = Object.entries(service.selector ?? {}).map(([key, value]) => `${key}=${value}`).join(',');
    if (!selector) throw new Error(t('error.noSelector'));
    return this.podList(profile, service.namespace, signal, selector);
  }

  async resource(profile, target, signal, { fresh = false } = {}) {
    if (signal?.aborted) throw new DOMException(t('error.requestCancelled'), 'AbortError');
    const key = this.resourceKey(profile, target);
    const cached = this.details.get(key);
    if (!fresh && cached && Date.now() - cached.at < 30000) return cached.value;
    const result = JSON.parse(await this.pool.run(['get', ...this.args(profile), '--request-timeout=20s', `--namespace=${target.namespace}`, `${target.kind}/${target.name}`, '--output=json'], { signal }));
    const value = target.kind === 'pod' ? podSummary(result) :
      { ...target, status: result.spec.type, ports: portsOf(result.spec.ports ?? []), selector: result.spec.selector ?? {} };
    return this.remember(this.details, key, { ...value, detailsAt: Date.now() });
  }

  async servicesFor(profile, pod, signal) {
    if (signal?.aborted) throw new DOMException(t('error.requestCancelled'), 'AbortError');
    const resource = pod.compact ? await this.resource(profile, pod, signal) : pod;
    const cached = this.serviceLists.get(JSON.stringify([profile.file, profile.context, pod.namespace]));
    const services = cached && Date.now() - cached.at < 30000 ? cached.value : await this.list(profile, pod.namespace, 'service', signal);
    return services.filter(service => Object.keys(service.selector).length &&
      Object.entries(service.selector).every(([key, value]) => resource.labels?.[key] === value));
  }

  prepareForward(spec, signal) { return this.privileged.prepare(spec, signal); }

  checkConnection(profile, signal) {
    return this.pool.run(['get', ...this.args(profile), '--raw=/version', '--request-timeout=4s'], { signal, timeout: 5000 });
  }

  forward(profile, spec, callbacks, prepared) {
    const start = (port, address, handlers) => this.pool.start(['port-forward', ...this.args(profile), `--namespace=${spec.namespace}`,
      `--address=${address}`, '--pod-running-timeout=15s', `${spec.kind}/${spec.name}`, `${port}:${spec.remotePort}`], handlers);
    return prepared?.privileged ? this.privileged.forward(spec, start, callbacks) : start(spec.localPort, spec.address, callbacks);
  }

  logs(profile, pod, container, callbacks, { follow = true, tail = initialLogLines, sinceTime } = {}) {
    return this.pool.start(['logs', ...this.args(profile), `--namespace=${pod.namespace}`, pod.name,
      `--container=${container}`, ...(follow ? ['--follow=true'] : []), `--tail=${tail}`, '--timestamps=true',
      ...(sinceTime ? [`--since-time=${sinceTime}`] : [])], callbacks);
  }

  logHistory(profile, pod, container, callbacks) {
    return this.logs(profile, pod, container, callbacks, { follow: false, tail: -1 });
  }
}
