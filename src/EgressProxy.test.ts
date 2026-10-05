import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createEgressProxy, hostAllowed } from './EgressProxy.js';

describe('the egress allowlist', () => {
  it('matches exact hosts on 443, host:port rules, and wildcard subdomains', () => {
    const allow = ['api.anthropic.com', '*.googleapis.com', '127.0.0.1:9999'];
    assert.equal(hostAllowed('api.anthropic.com', 443, allow), true);
    assert.equal(hostAllowed('API.Anthropic.com.', 443, allow), true, 'case and a trailing dot do not matter');
    assert.equal(hostAllowed('api.anthropic.com', 80, allow), false, 'a bare rule is 443 only');
    assert.equal(hostAllowed('evil-api.anthropic.com', 443, allow), false);
    assert.equal(hostAllowed('anthropic.com', 443, allow), false);
    assert.equal(hostAllowed('generativelanguage.googleapis.com', 443, allow), true);
    assert.equal(hostAllowed('googleapis.com', 443, allow), false, 'the wildcard needs a subdomain');
    assert.equal(hostAllowed('127.0.0.1', 9999, allow), true);
    assert.equal(hostAllowed('127.0.0.1', 443, allow), false);
    assert.equal(hostAllowed('', 443, allow), false);
  });
});

function listen(server: net.Server | ReturnType<typeof createEgressProxy>): Promise<number> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
}

/** Sends one CONNECT and returns the status line plus whatever the tunnel echoes back. */
function connectThrough(proxyPort: number, target: string, payload: string): Promise<{ status: string; echoed: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1');
    let buffer = '';
    let status = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      if (!status && buffer.includes('\r\n\r\n')) {
        status = buffer.split('\r\n')[0];
        buffer = buffer.slice(buffer.indexOf('\r\n\r\n') + 4);
        if (status.startsWith('HTTP/1.1 200')) socket.write(payload);
        else socket.end();
      } else if (status && buffer.includes(payload)) {
        socket.end();
      }
    });
    socket.on('close', () => resolve({ status, echoed: buffer }));
    socket.on('error', reject);
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  });
}

describe('the egress proxy', () => {
  it('tunnels CONNECT to an allowlisted host:port and refuses everything else', async () => {
    const echo = net.createServer(socket => socket.pipe(socket));
    const echoPort = await listen(echo);
    const seen: string[] = [];
    const proxy = createEgressProxy({ allow: [`127.0.0.1:${echoPort}`], log: line => seen.push(line) });
    const proxyPort = await listen(proxy);
    try {
      const allowed = await connectThrough(proxyPort, `127.0.0.1:${echoPort}`, 'ping');
      assert.equal(allowed.status, 'HTTP/1.1 200 Connection Established');
      assert.equal(allowed.echoed, 'ping', 'bytes flow both ways through the tunnel');

      const otherPort = await connectThrough(proxyPort, `127.0.0.1:${echoPort + 1}`, 'ping');
      assert.equal(otherPort.status, 'HTTP/1.1 403 Forbidden');
      const otherHost = await connectThrough(proxyPort, 'example.com:443', 'ping');
      assert.equal(otherHost.status, 'HTTP/1.1 403 Forbidden');
      assert.ok(seen.some(l => l === `allow connect 127.0.0.1:${echoPort}`), seen.join('\n'));
      assert.ok(seen.some(l => l === 'deny connect example.com:443'));
    } finally {
      proxy.close();
      echo.close();
    }
  });

  it('refuses plain HTTP requests, which would carry traffic in the clear', async () => {
    const proxy = createEgressProxy({ allow: ['example.com'] });
    const port = await listen(proxy);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/anything`, { method: 'GET' });
      assert.equal(response.status, 403);
      assert.match(await response.text(), /only CONNECT to allowlisted hosts/);
    } finally {
      proxy.close();
    }
  });
});
