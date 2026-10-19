// Forwards the sandboxed model's API requests to the AI Gateway, adding the
// gateway token on the way, so the token never enters the sandbox. It prints
// its port once listening.
import { request } from 'node:https';
import { createServer } from 'node:http';

const token = process.env.CF_AIG_TOKEN;
const base = `https://gateway.ai.cloudflare.com/v1/${process.env.CF_ACCOUNT_ID}/${process.env.CF_GATEWAY_ID}/anthropic`;
// Anything in the sandbox can reach this port, so cap what a runaway or
// hostile process can spend beyond the model's own budget.
let remaining = Number(process.env.BOT_PROXY_MAX_REQUESTS || 2000);

const DROP = new Set(['host', 'authorization', 'x-api-key', 'cf-aig-authorization', 'connection']);

const server = createServer((req, res) => {
  if (remaining-- <= 0 || !req.url.startsWith('/v1/')) {
    res.writeHead(403).end();
    return;
  }
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !DROP.has(k)));
  headers.authorization = `Bearer ${token}`;
  headers['cf-aig-authorization'] = `Bearer ${token}`;
  const upstream = request(`${base}${req.url}`, { method: req.method, headers }, up => {
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
  });
  upstream.on('error', e => {
    console.error(`upstream: ${e.message}`);
    res.destroy();
  });
  req.pipe(upstream);
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
