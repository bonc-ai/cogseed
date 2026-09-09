import { describe, expect, it, vi } from 'vitest';

import { HttpFeishuApiClient } from '../../../src/main/features/personal_context/feishu/api-client';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HttpFeishuApiClient Wiki discovery', () => {
  it('lists every visible space, follows page tokens, and walks child nodes', async () => {
    const calls: URL[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      calls.push(url);
      if (url.pathname === '/open-apis/wiki/v2/spaces') {
        if (url.searchParams.get('page_token') === 'spaces-page-2') {
          return jsonResponse({ code: 0, data: { items: [{ space_id: 'space-2' }], has_more: false } });
        }
        return jsonResponse({
          code: 0,
          data: { items: [{ space_id: 'space-1' }], has_more: true, page_token: 'spaces-page-2' },
        });
      }
      if (url.pathname === '/open-apis/wiki/v2/spaces/space-1/nodes' && !url.searchParams.get('parent_node_token')) {
        return jsonResponse({
          code: 0,
          data: { items: [{ node_token: 'root-1', obj_token: 'doc-root-1', obj_type: 'docx', title: '根页面', has_child: true }], has_more: false },
        });
      }
      if (url.pathname === '/open-apis/wiki/v2/spaces/space-1/nodes' && url.searchParams.get('parent_node_token') === 'root-1') {
        return jsonResponse({
          code: 0,
          data: { items: [{ node_token: 'child-1', obj_token: 'doc-child-1', obj_type: 'docx', title: '子页面' }], has_more: false },
        });
      }
      if (url.pathname === '/open-apis/wiki/v2/spaces/space-2/nodes') {
        return jsonResponse({
          code: 0,
          data: { items: [{ node_token: 'root-2', obj_token: 'doc-root-2', obj_type: 'docx', title: '第二空间页面' }], has_more: false },
        });
      }
      return jsonResponse({ code: 0, data: { items: [], has_more: false } });
    });
    const client = new HttpFeishuApiClient({
      accessToken: 'test-token',
      baseUrl: 'https://feishu.test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const nodes = await client.listWikiNodes();

    expect(nodes.map((node) => [node.space_id, node.node_token])).toEqual([
      ['space-1', 'root-1'],
      ['space-1', 'child-1'],
      ['space-2', 'root-2'],
    ]);
    expect(calls[0].searchParams.get('page_size')).toBe('50');
    expect(calls.filter((url) => url.pathname.includes('/wiki/v2/spaces')).every((url) => url.searchParams.get('page_size') === '50')).toBe(true);
    expect(calls.some((url) => url.searchParams.get('page_token') === 'spaces-page-2')).toBe(true);
  });

  it('refreshes once and retries when Feishu rejects an expired access token', async () => {
    const authorizations: string[] = [];
    const refreshAccessToken = vi.fn(async () => 'fresh-token');
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const authorization = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '');
      authorizations.push(authorization);
      if (authorization === 'Bearer stale-token') {
        return errorResponse(401, { code: 99991677, msg: 'Authentication token expired. Please request a new one.' });
      }
      return jsonResponse({ code: 0, data: { items: [], has_more: false } });
    });
    const client = new HttpFeishuApiClient({
      accessToken: 'stale-token',
      refreshAccessToken,
      baseUrl: 'https://feishu.test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.listWikiNodes()).resolves.toEqual([]);
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(refreshAccessToken).toHaveBeenCalledWith('stale-token');
    expect(authorizations.slice(0, 2)).toEqual(['Bearer stale-token', 'Bearer fresh-token']);
  });
});
