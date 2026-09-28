'use strict';

/**
 * Install proxy routing for an app-owned Node child process. Explicit env
 * proxies use undici directly; system policy is evaluated per request by the
 * Electron parent. This file must stay silent on stdout because connector
 * children use stdout as their MCP JSON-RPC transport.
 */

function installChildProxy() {
  const mode = String(process.env.COGSEED_PROXY_MODE || '').trim();
  if (!mode || mode === 'direct') return false;
  if (mode === 'unsupported') {
    const route = String(process.env.COGSEED_PROXY_UNSUPPORTED || 'unknown').slice(0, 80);
    throw new Error(`system proxy route is unsupported for this child process: ${route}`);
  }

  if (mode === 'system-fetch') {
    const bridgeUrl = process.env.COGSEED_PROXY_BRIDGE_URL;
    const bridgeToken = process.env.COGSEED_PROXY_BRIDGE_TOKEN;
    if (!bridgeUrl || !bridgeToken) throw new Error('system fetch bridge configuration is incomplete');
    globalThis.fetch = createBridgeFetch(globalThis.fetch.bind(globalThis), bridgeUrl, bridgeToken);
    return true;
  }

  const {
    EnvHttpProxyAgent,
    setGlobalDispatcher,
  } = require('undici');
  const dispatcherOpts = {
    headersTimeout: 0,
    bodyTimeout: 0,
    connect: { timeout: 30_000 },
  };

  if (mode === 'env') {
    const httpProxy = process.env.COGSEED_PROXY_HTTP_URL || undefined;
    const httpsProxy = process.env.COGSEED_PROXY_HTTPS_URL || undefined;
    if (!httpProxy && !httpsProxy) return false;
    setGlobalDispatcher(new EnvHttpProxyAgent({
      ...(httpProxy ? { httpProxy } : {}),
      ...(httpsProxy ? { httpsProxy } : {}),
      noProxy: process.env.COGSEED_PROXY_NO_PROXY || 'localhost,127.0.0.1,::1,*.local',
      ...dispatcherOpts,
    }));
    return true;
  }

  throw new Error(`unknown child proxy mode: ${mode.slice(0, 40)}`);
}

function encodeMeta(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * Take ownership of an upstream fetch body before dropping the Response object
 * that produced it.
 *
 * undici cancels a fetch Response's body when the Response object is garbage
 * collected while its stream is neither locked nor disturbed (its fetch
 * implementation registers the stream in a FinalizationRegistry). Re-wrapping
 * `response.body` in a new Response keeps only the stream, so any GC between
 * the bridge call and the caller reading the body cancels a response that is
 * still in flight. The child sees
 * `TypeError: Body is unusable: Body has already been read`.
 *
 * Piping through a TransformStream locks the upstream stream immediately, so
 * that finalizer can never cancel it, and hands the caller a stream this module
 * owns. Streaming, backpressure and cancellation propagate unchanged.
 */
function takeOwnershipOfBody(body) {
  if (!body) return null;
  return body.pipeThrough(new TransformStream());
}

function decodeMeta(value) {
  if (!value) throw new Error('system fetch bridge returned no metadata');
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

/**
 * Route each child fetch through the Electron parent. The parent uses
 * net.fetch, so PAC/DIRECT/proxy-auth and runtime changes are evaluated for the
 * request's real URL instead of being frozen when the child starts.
 */
function createBridgeFetch(nativeFetch, bridgeUrl, bridgeToken) {
  return async function bridgeFetch(input, init) {
    const request = new Request(input, init);
    const protocol = new URL(request.url).protocol;
    if (protocol !== 'http:' && protocol !== 'https:') return nativeFetch(input, init);

    const meta = encodeMeta({
      url: request.url,
      method: request.method,
      headers: Array.from(request.headers.entries()),
      redirect: request.redirect,
    });
    const response = await nativeFetch(bridgeUrl, {
      method: 'POST',
      headers: {
        'x-cogseed-proxy-token': bridgeToken,
        'x-cogseed-fetch-meta': meta,
      },
      signal: request.signal,
      ...(request.body ? { body: request.body, duplex: 'half' } : {}),
    });
    if (!response.ok) {
      const detail = String(response.headers.get('x-cogseed-bridge-error') || `HTTP ${response.status}`)
        .slice(0, 200);
      throw new Error(`system fetch bridge failed: ${detail}`);
    }
    const responseMeta = decodeMeta(response.headers.get('x-cogseed-fetch-meta'));
    return new Response(takeOwnershipOfBody(response.body), {
      status: responseMeta.status,
      statusText: responseMeta.statusText,
      headers: responseMeta.headers,
    });
  };
}

installChildProxy();

module.exports = { createBridgeFetch, installChildProxy };
