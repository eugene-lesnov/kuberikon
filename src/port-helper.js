import { createServer, createConnection, isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

export async function runPortHelper() {
  const { values } = parseArgs({ options: { address: { type: 'string' }, port: { type: 'string' }, 'target-port': { type: 'string' },
    parent: { type: 'string' }, 'parent-start': { type: 'string' } }, args: process.argv.slice(3) });
  const number = value => /^\d+$/.test(value ?? '') && Number.isSafeInteger(Number(value)) ? Number(value) : NaN;
  const uid = number(process.env.SUDO_UID);
  const gid = number(process.env.SUDO_GID);
  const port = number(values.port);
  const targetPort = number(values['target-port']);
  const parent = number(values.parent);
  const address = values.address;
  if (process.platform !== 'linux' || process.getuid() !== 0 || process.geteuid() !== 0 || !(uid > 0) || !(gid >= 0) || !(parent > 1) || !/^\d+$/.test(values['parent-start'] ?? '') ||
    !(port >= 1 && port <= 65535) || !(targetPort >= 1 && targetPort <= 65535) || (address !== 'localhost' && !isIP(address ?? ''))) throw new Error('Invalid privileged port helper request');
  const parentAlive = async () => {
    const stat = await readFile(`/proc/${parent}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === values['parent-start'];
  };
  if (!await parentAlive()) throw new Error('The parent session is no longer running');
  const servers = [];
  const sockets = new Set();
  let ready = false;
  let closing = false;
  let timer;
  const stop = () => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    for (const socket of sockets) socket.destroy();
    for (const server of servers) server.close();
    process.stdin.destroy();
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, stop);
  process.stdin.on('end', stop);
  process.stdin.on('error', stop);
  process.stdin.resume();
  const accept = client => {
    if (!ready || closing) { client.destroy(); return; }
    const target = createConnection({ host: '127.0.0.1', port: targetPort, allowHalfOpen: true });
    sockets.add(client); sockets.add(target);
    const failed = () => { client.destroy(); target.destroy(); };
    client.once('error', failed);
    target.once('error', failed);
    client.once('close', () => sockets.delete(client));
    target.once('close', () => sockets.delete(target));
    target.once('connect', () => { client.pipe(target); target.pipe(client); client.resume(); });
  };
  try {
    for (const host of address === 'localhost' ? ['127.0.0.1', '::1'] : [address]) {
      if (closing) throw new Error('Port binding was cancelled');
      const server = createServer({ pauseOnConnect: true, allowHalfOpen: true }, accept);
      servers.push(server);
      try {
        await new Promise((resolveListen, reject) => {
          server.once('error', reject);
          server.listen({ host, port, ipv6Only: Boolean(isIP(host) === 6) }, () => { server.removeListener('error', reject); resolveListen(); });
        });
      } catch (error) {
        if (host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) { servers.pop(); continue; }
        throw error;
      }
      server.on('error', error => { process.stderr.write(`Port listener failed: ${error.message}\n`); process.exitCode = 1; stop(); });
    }
    process.setgroups([]);
    process.setgid(gid);
    process.setuid(uid);
    if (process.getuid() !== uid || process.geteuid() !== uid || process.getgid() !== gid || process.getegid() !== gid || closing || !await parentAlive()) throw new Error('Could not enter the user session');
    timer = setInterval(() => { void parentAlive().then(alive => { if (!alive) stop(); }, stop); }, 1000);
    ready = true;
    process.stdout.on('error', stop);
    process.stdout.write(`READY ${process.pid}\n`);
  } catch (error) { stop(); throw error; }
}
