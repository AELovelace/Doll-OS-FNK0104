#!/usr/bin/env node
//   asuka-proxy/server.js
//   Small standalone relay so dapp-web (a static site with no server of its own --
//   see dapp-web/README.md) can let visitors' browsers reach a home-network AI
//   server that isn't itself internet-reachable or CORS-enabled. Intended to run
//   behind an existing public reverse proxy (e.g. nginx) that terminates TLS and
//   forwards to this process; this process then makes the actual LAN call.
//
//   Deliberately dependency-free (only Node core modules) so deployment is just
//   `node server.js` -- no package.json, no npm install, matching dapp-web's own
//   "no build step" spirit for the static site.
//
//   Point dapp-web's shipped apps/llm-chat.dapp at this proxy: set its `endpoint`
//   to this server's public URL + the allowed path (default /v1/chat/completions),
//   and its "Bearer token" prompt to AUTH_TOKEN below. See README.md.

'use strict';

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const config = {
  listenPort: parsePort(process.env.LISTEN_PORT, 8787),
  listenHost: process.env.LISTEN_HOST || '127.0.0.1',
  upstreamUrl: new URL(process.env.UPSTREAM_URL || 'http://192.168.1.250:9090'),
  authToken: process.env.AUTH_TOKEN || '',
  allowedOrigin: process.env.ALLOWED_ORIGIN || '*',
  allowedPaths: (process.env.ALLOWED_PATHS || '/v1/chat/completions')
    .split(',').map(p => p.trim()).filter(Boolean),
  maxBodyBytes: parsePort(process.env.MAX_BODY_BYTES, 1_000_000),
  rateLimitPerMin: parsePort(process.env.RATE_LIMIT_PER_MIN, 20),
  requestTimeoutMs: parsePort(process.env.UPSTREAM_TIMEOUT_MS, 60_000)
};

function parsePort(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

if (!config.authToken) {
  console.error('asuka-proxy: refusing to start with no AUTH_TOKEN set -- this ' +
    'process forwards internet traffic into your LAN, so an empty/missing token ' +
    'is treated as a misconfiguration, not "open access". Set AUTH_TOKEN and retry.');
  process.exit(1);
}

//per-IP sliding window: a Map of ip -> array of request timestamps (ms), pruned
//lazily on each check. Fine at demo scale; not meant to survive a restart.
const requestLog = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const timestamps = (requestLog.get(ip) || []).filter(t => t > windowStart);
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  return timestamps.length > config.rateLimitPerMin;
}

//constant-time-ish compare so a mistyped token doesn't leak how many leading
//characters matched via response timing
function tokenMatches(candidate) {
  const a = Buffer.from(candidate || '');
  const b = Buffer.from(config.authToken);
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b); //keep the timing profile similar either way
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

//trusts X-Forwarded-For because this proxy is meant to run behind a reverse
//proxy on the same box (see README) -- takes the first hop, the original
//client, not any intermediate forwarder
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': config.allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '600'
  };
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders() });
  res.end(text);
}

function bearerToken(req) {
  const header = req.headers['authorization'] || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : '';
}

const server = http.createServer((req, res) => {
  const ip = clientIp(req);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/healthz') {
    //unauthenticated on purpose -- just confirms this process is alive, no
    //upstream call, safe to leave open for uptime checks
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  const requestUrl = new URL(req.url, 'http://localhost');
  if (!config.allowedPaths.includes(requestUrl.pathname)) {
    sendJson(res, 404, { error: 'path not allowed' });
    return;
  }

  if (!tokenMatches(bearerToken(req))) {
    sendJson(res, 401, { error: 'missing or invalid bearer token' });
    return;
  }

  if (rateLimited(ip)) {
    sendJson(res, 429, { error: 'rate limit exceeded, try again shortly' });
    return;
  }

  const chunks = [];
  let receivedBytes = 0;
  let tooLarge = false;

  req.on('data', chunk => {
    if (tooLarge) return;
    receivedBytes += chunk.length;
    if (receivedBytes > config.maxBodyBytes) {
      tooLarge = true;
      sendJson(res, 413, { error: 'request body too large' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (tooLarge) return;
    forwardToUpstream(Buffer.concat(chunks), requestUrl, req, res);
  });

  req.on('error', () => {
    if (!res.headersSent) sendJson(res, 400, { error: 'malformed request' });
  });
});

function forwardToUpstream(body, requestUrl, clientReq, clientRes) {
  const upstreamHeaders = {
    'Content-Type': clientReq.headers['content-type'] || 'application/json',
    'Content-Length': Buffer.byteLength(body)
  };
  //the client's bearer token authenticates it to *this* proxy; it is not
  //forwarded upstream, since the LAN AI server is trusted implicitly once a
  //request reaches it and doesn't need (or expect) our shared secret

  const upstreamReq = http.request({
    hostname: config.upstreamUrl.hostname,
    port: config.upstreamUrl.port || 80,
    path: requestUrl.pathname + requestUrl.search,
    method: 'POST',
    headers: upstreamHeaders,
    timeout: config.requestTimeoutMs
  }, upstreamRes => {
    //Node lower-cases incoming header names for us, so a plain lookup is enough
    const headers = { ...corsHeaders() };
    if (upstreamRes.headers['content-type']) headers['Content-Type'] = upstreamRes.headers['content-type'];
    if (upstreamRes.headers['cache-control']) headers['Cache-Control'] = upstreamRes.headers['cache-control'];
    clientRes.writeHead(upstreamRes.statusCode || 502, headers);
    //piped, not buffered, so a streaming (SSE) upstream response reaches the
    //browser incrementally instead of waiting for the whole reply
    upstreamRes.pipe(clientRes);
  });

  upstreamReq.on('timeout', () => {
    upstreamReq.destroy(new Error('upstream timed out'));
  });

  upstreamReq.on('error', err => {
    console.error('asuka-proxy: upstream request failed:', err.message);
    if (!clientRes.headersSent) {
      sendJson(clientRes, 502, { error: 'upstream AI server unreachable' });
    } else {
      clientRes.end();
    }
  });

  upstreamReq.end(body);
}

server.listen(config.listenPort, config.listenHost, () => {
  console.log(`asuka-proxy: listening on http://${config.listenHost}:${config.listenPort}, ` +
    `forwarding ${config.allowedPaths.join(', ')} to ${config.upstreamUrl.origin}`);
});
