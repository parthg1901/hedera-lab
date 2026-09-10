import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createTicketService } from './ticket-service.mjs';
const bridge = process.env.HARNESS_LAB_URL;
const token = process.env.HARNESS_LAB_TOKEN;
if (!bridge || !token) throw new Error('Start this test app through hedera-harness lab run');
const ledger = async (route, operation) => {
  const response = await fetch(`${bridge}${route}`, {
    method: operation ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: operation ? JSON.stringify(operation) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Lab adapter HTTP ${response.status}`);
  return response.json();
};
const capabilities = await ledger('/capabilities');
const service = createTicketService(ledger, { recoverable: capabilities.durableReceipts === true });
const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.setHeader('Content-Type', 'text/html'); res.end(html); return;
  }
  // Test app binds to loopback and exposes only two predefined test actions.
  if (req.method === 'POST' && ['/api/buy', '/api/check-in'].includes(req.url)) {
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403).end(); return; }
    res.setHeader('Content-Type', 'application/json');
    try { res.end(JSON.stringify(await service.handle(req.url.slice(5)))); }
    catch { res.writeHead(503).end(JSON.stringify({ ok: false, message: 'Network unavailable' })); }
    return;
  }
  res.writeHead(404).end();
});
server.listen(0, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${server.address().port}`));
