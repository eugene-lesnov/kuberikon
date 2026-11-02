import { createServer, isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { t } from './i18n/index.js';

export function declaredForwardPorts(resource) {
  const ports = new Map();
  for (const port of resource?.ports ?? []) {
    const target = resource.kind === 'service' && port.name ? port.name : String(port.port);
    if (!ports.has(target)) ports.set(target, port);
  }
  return ports;
}

export async function privilegedPortThreshold() {
  const source = (await readFile('/proc/sys/net/ipv4/ip_unprivileged_port_start', 'utf8')).trim();
  if (!/^\d+$/.test(source) || Number(source) > 65535) throw new Error(t('error.portThreshold'));
  return Number(source);
}

export function addressesOverlap(left, right) {
  if (left === right || left === '::' || right === '::') return true;
  const hosts = value => value === 'localhost' ? ['127.0.0.1', '::1'] : [value];
  return hosts(left).some(a => hosts(right).some(b => a === b || a === '0.0.0.0' && isIP(b) === 4 || b === '0.0.0.0' && isIP(a) === 4));
}

async function probePort(address, port, signal, allowPermissionDenied = false) {
  if (signal?.aborted) throw new DOMException(t('error.requestCancelled'), 'AbortError');
  const servers = [];
  let boundPort = port;
  let available = 0;
  try {
    for (const host of address === 'localhost' ? ['127.0.0.1', '::1'] : [address]) {
      const server = createServer(socket => socket.destroy());
      servers.push(server);
      let abort;
      try {
        await new Promise((resolve, reject) => {
          abort = () => { reject(new DOMException(t('error.requestCancelled'), 'AbortError')); server.close(); };
          signal?.addEventListener('abort', abort, { once: true });
          server.once('error', reject);
          server.listen({ host, port: boundPort, exclusive: true }, resolve);
          if (signal?.aborted) abort();
        });
        if (signal?.aborted) throw new DOMException(t('error.requestCancelled'), 'AbortError');
        boundPort = server.address().port;
        available++;
      } catch (error) {
        if (signal?.aborted) throw new DOMException(t('error.requestCancelled'), 'AbortError');
        if (allowPermissionDenied && error.code === 'EACCES') { available++; continue; }
        if (address === 'localhost' && ['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code)) continue;
        throw error;
      } finally { signal?.removeEventListener('abort', abort); }
    }
    if (!available) throw new Error(t('error.localAddress', { address }));
    return boundPort;
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  }
}

export async function assertLocalPort(spec, signal, threshold) {
  try { await probePort(spec.address, spec.localPort, signal, spec.localPort < threshold); }
  catch (error) {
    if (error.code === 'EADDRINUSE') throw new Error(t('error.portInUse', { address: spec.address, port: spec.localPort }));
    throw error;
  }
}

export async function suggestLocalPort(preferred, address, forwards, signal) {
  const threshold = await privilegedPortThreshold();
  const minimum = Math.max(1024, threshold);
  const reserved = new Set(forwards.filter(record => addressesOverlap(address, record.spec.address)).map(record => record.spec.localPort));
  let candidate = Number(preferred);
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > 65535) candidate = Math.max(8080, minimum);
  for (let attempt = 0; attempt < 128; attempt++) {
    while (reserved.has(candidate) && candidate <= 65535) candidate++;
    if (candidate > 65535) candidate = 0;
    try {
      const port = await probePort(address, candidate, signal);
      if (port >= minimum && !reserved.has(port)) return port;
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
    if (candidate) candidate++;
  }
  throw new Error(t('error.noFreePort'));
}
