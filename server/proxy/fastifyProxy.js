import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { buildHeaderProfile, pickHeaderProfileForUrl } from './requestUpstream.js';
import { rewritePlaylistIfNeeded } from './streamRewrite.js';
import { selectProxyForRequest, markProxyFailure, markProxySuccess } from './proxyManager.js';

function isLikelyPlaylistUrl(targetUrl, contentType) {
  const u = String(targetUrl || '');
  return (
    /\.m3u8?(\?|$)/i.test(u) ||
    /mpegurl|application\/vnd\.apple\.mpegurl|application\/x-mpegurl|text\/plain/i.test(contentType || '')
  );
}

export function registerProxyRoutes(app) {
  // NEW: /proxy (primary)
  app.get('/proxy', async (req, reply) => {
    const targetUrl = typeof req.query?.url === 'string' ? req.query.url : '';
    if (!targetUrl) {
      reply.code(400);
      return { error: 'url is required' };
    }

    // Stream health: retry via proxy failover at backend.
    // failoverIndex increments on each internal attempt.
    const MAX_FAILOVER = 4;

    for (let failoverIndex = 0; failoverIndex < MAX_FAILOVER; failoverIndex++) {
      const choice = await selectProxyForRequest({ failoverIndex });
      const { poolName, proxyUrl } = choice;

      const headerProfile = pickHeaderProfileForUrl(targetUrl);
      const headers = {
        ...buildHeaderProfile(headerProfile),
        // Optional spoofing hooks
        Referer: new URL(targetUrl).origin,
        Origin: new URL(targetUrl).origin
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);

      const startedAt = Date.now();

      try {
        // IMPORTANT: We are implementing DIRECT LOCAL FETCH mode now.
        // ProxyUrl (external proxies) are marked but not yet tunnelled by Node fetch.
        // This keeps compilation stable while we still deliver the core: all browser traffic
        // passes through local relay.

        const response = await fetch(targetUrl, {
          headers,
          redirect: 'follow',
          signal: controller.signal
        });

        clearTimeout(timeout);

        const contentType = response.headers.get('content-type') || 'application/octet-stream';
        reply.header('Content-Type', contentType);
        reply.code(response.status);

        if (response.status === 403 || response.status === 401 || response.status === 451) {
          markProxyFailure({ poolName, proxyUrl });
          continue;
        }

        if (isLikelyPlaylistUrl(targetUrl, contentType) || /#EXTM3U/i.test(String(await response.clone().text().catch(() => '')))) {
          // Need text; consume clone
          const text = await response.text();
          const { rewritten, body } = rewritePlaylistIfNeeded({ text, targetUrl, req });
          // Always rewrite HLS URIs via /proxy so nested segments also go through relay.
          reply.send(rewritten ? body : body);
          markProxySuccess({ poolName, proxyUrl, latencyMs: Date.now() - startedAt });
          return;
        }

        // CORS: browser will request from same origin; still set permissive for media tags.
        reply.header('Access-Control-Allow-Origin', '*');

        if (!response.body) {
          reply.send('');
          return;
        }

        return reply.send(Readable.fromWeb(response.body));
      } catch (e) {
        clearTimeout(timeout);
        markProxyFailure({ poolName, proxyUrl });
        // try next failover
        if (failoverIndex === MAX_FAILOVER - 1) {
          reply.code(502);
          return { error: e instanceof Error ? e.message : 'proxy failed' };
        }
      }
    }

    reply.code(502);
    return { error: 'proxy failed' };
  });

  // NEW: /proxy/test (mini test player endpoint)
  app.get('/proxy/test', async (req, reply) => {
    const targetUrl = typeof req.query?.url === 'string' ? req.query.url : '';
    if (!targetUrl) {
      reply.code(400);
      return { status: 'invalid', error: 'url is required' };
    }

    const startedAt = Date.now();
    try {
      const headers = {
        Accept: '*/*',
        'User-Agent': 'IPTV Proxy Relay Test/1.0',
        Range: 'bytes=0-2047'
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const response = await fetch(targetUrl, {
        headers,
        redirect: 'follow',
        signal: controller.signal
      });

      clearTimeout(timeout);
      const contentType = response.headers.get('content-type') || '';

      const ok = response.ok || response.status === 206;
      const status = ok ? 'WORKING' : 'DEAD';

      // block detection
      const probeText = '';
      const blocked = [401, 403, 451].includes(response.status) || /text\/html/i.test(contentType);

      reply.send({
        status: blocked ? 'BLOCKED' : status,
        httpCode: response.status,
        contentType,
        latencyMs: Date.now() - startedAt
      });
    } catch (e) {
      reply.send({
        status: 'TIMEOUT',
        latencyMs: Date.now() - startedAt,
        error: e instanceof Error ? e.message : 'timeout'
      });
    }
  });
}

