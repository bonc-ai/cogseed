import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';

import { appendCreatorAudit, listCreatorAudit } from '../../../../src/main/features/creator/store';
import * as users from '../../../../src/main/features/users';
import { userRoot } from '../../../../src/main/paths';

const userId = 'creator-security-user';

beforeEach(async () => {
  await fs.rm(userRoot(userId), { recursive: true, force: true });
  users.activateUser(userId);
});

afterEach(async () => {
  await fs.rm(userRoot(userId), { recursive: true, force: true });
});

describe('Creator audit redaction', () => {
  it('redacts nested secret keys and positional secrets before durable audit append', async () => {
    await appendCreatorAudit(userId, {
      event: 'creator.validation.failed',
      metadata: {
        token: 'raw-token',
        nested: { api_key: 'sk-secret-value', safe: 'kept' },
        error: 'Authorization: Bearer abcDEF1234567890 access_token=secret-value',
        contact: 'alice@example.com / 13800138000',
      },
    });

    const record = (await listCreatorAudit(userId))[0];
    const json = JSON.stringify(record);
    expect(json).not.toContain('raw-token');
    expect(json).not.toContain('sk-secret-value');
    expect(json).not.toContain('abcDEF1234567890');
    expect(json).not.toContain('secret-value');
    expect(json).not.toContain('alice@example.com');
    expect(json).not.toContain('13800138000');
    expect(json).toContain('safe');
  });

  it('preserves traceability identifiers while excluding sensitive credentials', async () => {
    await appendCreatorAudit(userId, {
      event: 'creator.validation.completed',
      metadata: {
        runId: 'run-1',
        requestId: 'request-1',
        resourceId: 'resource-a',
        authorization: 'Bearer secret-value',
        dial_token: 'secret-token',
      },
    });

    const metadata = (await listCreatorAudit(userId))[0].metadata as Record<string, unknown>;
    expect(metadata.runId).toBe('run-1');
    expect(metadata.requestId).toBe('request-1');
    expect(metadata.resourceId).toBe('resource-a');
    expect(metadata.authorization).toBe('[REDACTED]');
    expect(metadata.dial_token).toBe('[REDACTED]');
  });

  it('redacts credential, passphrase, path, and workspace path metadata before persistence', async () => {
    const values = {
      credential: 'credential-secret',
      passphrase: 'passphrase-secret',
      path: '/private/audit-secret',
      workspacePath: 'C:\\private\\audit-secret',
    };
    await appendCreatorAudit(userId, { event: 'creator.validation.failed', metadata: values });
    const text = JSON.stringify(await listCreatorAudit(userId));
    for (const value of Object.values(values)) expect(text).not.toContain(value);
    expect(text.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('redacts cookie and session credential metadata before persistence', async () => {
    const values = {
      cookie: 'session-cookie-secret',
      setCookie: 'set-cookie-secret',
      'headers.cookie': 'header-cookie-secret',
      sessionToken: 'session-token-secret',
    };
    await appendCreatorAudit(userId, { event: 'creator.validation.failed', metadata: values });
    const text = JSON.stringify(await listCreatorAudit(userId));
    for (const value of Object.values(values)) expect(text).not.toContain(value);
  });
});
