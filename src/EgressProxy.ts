import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

/**
 * A CONNECT-only HTTP proxy with a host allowlist. It is the only way out of
 * the agent container's network: the container sits on an internal Docker
 * network with no route to the internet, and this proxy is the one peer on
 * it that also has a route out. Every TLS connection the agent makes goes
 * through CONNECT here and is refused unless the host is on the list.
 *
 * This file must stay dependency-free (node builtins only): the built
 * JavaScript is mounted into a plain node image and run as a script.
 */
/** A rule is `host` (port 443 only) or `host:port`; `*.example.com` matches subdomains. */
export function hostAllowed(host: string, port: number, allow: string[]): boolean {
  const target = host.trim().toLowerCase().replace(/\.$/, '');
  if (!target) return false;
  return allow.some(entry => {
    const rule = entry.trim().toLowerCase();
    if (!rule) return false;
    const at = rule.lastIndexOf(':');
    const ruleHost = at > 0 ? rule.slice(0, at) : rule;
    const rulePort = at > 0 ? Number(rule.slice(at + 1)) : 443;
    if (rulePort !== port) return false;
    if (ruleHost.startsWith('*.')) return target.endsWith(ruleHost.slice(1)) && target.length > ruleHost.length - 1;
    return target === ruleHost;
  });
}

export interface EgressProxyOptions {
  allow: string[];
  log?: (line: string) => void;
}

export function createEgressProxy(options: EgressProxyOptions): http.Server {
  const log = options.log || (() => {});
  const server = http.createServer((request, response) => {
    // Plain HTTP never leaves: model APIs are TLS, and anything else is not ours to carry.
    log(`deny http ${request.method} ${request.url}`);
    response.writeHead(403, { 'content-type': 'text/plain' });
    response.end('softfactory egress proxy: only CONNECT to allowlisted hosts is permitted\n');
  });
  server.on('connect', (request, clientSocket, head) => {
    const [host, portText] = String(request.url || '').split(':');
    const port = Number(portText || 443);
    if (!Number.isInteger(port) || !hostAllowed(host, port, options.allow)) {
      log(`deny connect ${host}:${port}`);
      clientSocket.write('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nsoftfactory egress proxy: host not allowlisted\r\n');
      clientSocket.destroy();
      return;
    }
    const upstream = net.connect(port, host, () => {
      log(`allow connect ${host}:${port}`);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const close = () => { upstream.destroy(); clientSocket.destroy(); };
    upstream.on('error', error => { log(`upstream error ${host}:${port} ${error.message}`); close(); });
    clientSocket.on('error', close);
    upstream.setTimeout(10 * 60_000, close);
  });
  return server;
}

/** Run as a script: `EGRESS_ALLOW=a.com,b.com node EgressProxy.js` listens on PORT (default 3128). */
const invokedDirectly = (() => {
  try { return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]; }
  catch { return false; }
})();
if (invokedDirectly) {
  const allow = (process.env.EGRESS_ALLOW || '').split(',').map(s => s.trim()).filter(Boolean);
  const port = Number(process.env.PORT) || 3128;
  createEgressProxy({ allow, log: line => console.log(`[egress] ${line}`) }).listen(port, '0.0.0.0', () => {
    console.log(`[egress] listening on ${port}; allow: ${allow.join(', ') || '(nothing)'}`);
  });
}
