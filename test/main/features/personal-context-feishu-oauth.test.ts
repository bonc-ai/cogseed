import { describe, expect, it, vi } from 'vitest';

import { createFeishuTokenEndpoint, createFetchTransport } from '../../../src/main/features/personal_context/feishu/oauth';
import { TokenEndpointError } from '../../../src/main/features/personal_context/oauth-manager';

describe('Feishu OAuth token endpoint', () => {
  it('preserves Feishu error bodies on HTTP 400 and maps expired auth to reauthorization', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: 99991677,
      msg: 'Authentication token expired. Please request a new one.',
    }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }));
    const endpoint = createFeishuTokenEndpoint({
      app: { appId: 'app-id', appSecret: 'app-secret', redirectUri: 'http://127.0.0.1/callback' },
      transport: createFetchTransport(fetchImpl as unknown as typeof fetch),
    });

    await expect(endpoint.refreshToken('expired-refresh-token', [])).rejects.toMatchObject({
      name: TokenEndpointError.name,
      code: 'invalid_grant',
    });
  });
});
