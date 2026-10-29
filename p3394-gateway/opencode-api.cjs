/*
 * OpenCode 2 HTTP contract (verified against 2.0.29).
 * Detect capabilities before creating a session: v1 uses /session + /message;
 * v2 uses authenticated /api/session + /prompt, asynchronous admission, an
 * experimental idle wait, and projected messages. A successful prompt POST
 * is not a model reply. Read only messages after that admission's id, and
 * require a successful idle marker so old replies/partial errors cannot pass.
 * Passwords stay in the managed process environment and request headers.
 */
'use strict';

const http = require('node:http');

class OpencodeApi {
  constructor(base, password, username = 'opencode') {
    this.base = base;
    this.headers = { authorization: 'Basic ' + Buffer.from(username + ':' + password).toString('base64') };
    this.v2 = false;
  }

  async detect() {
    const response = await this.request('GET', '/openapi.json', undefined, { discovery: true });
    if ([404, 405].includes(response.status) || (response.status === 200 && /^\s*</.test(response.text))) return;
    if (response.status !== 200) throw new Error('p3394_opencode_discovery_http_' + response.status);
    const paths = response.json && response.json.paths;
    if (paths?.['/session']?.post && paths?.['/session/{sessionID}/message']?.post) return;
    if (!paths || !paths['/api/session']?.post) throw new Error('p3394_opencode_invalid_api');
    for (const route of ['/api/session/{sessionID}/prompt', '/api/experimental/session/{sessionID}/wait', '/api/session/{sessionID}/interrupt']) {
      if (!paths[route]?.post) throw new Error('p3394_opencode_unsupported_api');
    }
    if (!paths['/api/session/{sessionID}/message']?.get) throw new Error('p3394_opencode_unsupported_api');
    this.v2 = true;
  }

  request(method, route, body, opts = {}) {
    if (opts.isCancelled?.()) return Promise.reject(new Error('p3394_opencode_cancelled'));
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const req = http.request(this.base + route, {
        method,
        headers: { ...this.headers, ...(data === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }) },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('error', reject);
        res.on('end', () => {
          if (!opts.discovery && (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300)) {
            // Do not include server bodies: they can echo credentials or prompts.
            reject(new Error('p3394_opencode_http_' + res.statusCode + ': ' + method + ' ' + route.split('?')[0]));
            return;
          }
          let json;
          try { json = text ? JSON.parse(text) : undefined; } catch { /* discovery may receive the v1 web UI */ }
          resolve(opts.discovery ? { status: res.statusCode, text, json } : json);
        });
      });
      req.on('error', reject);
      opts.onRequest?.(req);
      req.end(data);
    });
  }

  async createSession(directory) {
    const response = await this.request('POST', '/api/session', { location: { directory } });
    if (typeof response?.data?.id !== 'string') throw new Error('p3394_opencode_session_failed');
    return response.data.id;
  }

  async deliver(sessionId, text, model, opts = {}) {
    const route = '/api/session/' + encodeURIComponent(sessionId);
    if (model) {
      const split = model.indexOf('/');
      if (split <= 0 || split === model.length - 1) throw new Error('p3394_opencode_invalid_model');
      await this.request('POST', route + '/model', { model: { providerID: model.slice(0, split), id: model.slice(split + 1) } }, opts);
    }
    const admitted = await this.request('POST', route + '/prompt', { text }, opts);
    const promptId = admitted?.data?.id;
    if (typeof promptId !== 'string' || !promptId) throw new Error('p3394_opencode_invalid_admission');
    await this.request('POST', '/api/experimental/session/' + encodeURIComponent(sessionId) + '/wait', {}, opts);

    // Descending pages bound each response and let us stop at this turn's user
    // message even when a tool-heavy turn exceeds the default page size.
    const messages = [];
    const cursors = new Set();
    let query = '?order=desc&limit=200';
    for (;;) {
      const page = await this.request('GET', route + '/message' + query, undefined, opts);
      if (opts.isCancelled?.()) throw new Error('p3394_opencode_cancelled');
      if (!Array.isArray(page?.data)) throw new Error('p3394_opencode_invalid_messages');
      const boundary = page.data.findIndex((message) => message.id === promptId && message.type === 'user');
      messages.push(...(boundary < 0 ? page.data : page.data.slice(0, boundary)));
      if (boundary >= 0) break;
      const next = page.cursor?.next;
      if (typeof next !== 'string' || !next || cursors.has(next)) throw new Error('p3394_opencode_missing_prompt');
      cursors.add(next);
      query = '?limit=200&cursor=' + encodeURIComponent(next);
    }
    const idle = messages.find((message) => message.type === 'idle');
    if (!idle || idle.outcome !== 'succeeded' || idle.error) throw new Error('p3394_opencode_turn_' + (idle?.outcome || 'incomplete'));
    const assistants = messages.reverse().filter((message) => message.type === 'assistant');
    if (assistants.some((message) => message.error || message.finish === 'error')) throw new Error('p3394_opencode_turn_failed');
    const reply = assistants.flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('');
    if (!reply.trim()) throw new Error('p3394_opencode_empty_reply');
    return reply;
  }
}

module.exports = { OpencodeApi };
