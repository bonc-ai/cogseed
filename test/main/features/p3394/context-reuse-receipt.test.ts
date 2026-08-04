import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

let userId = '';

beforeEach(() => {
  userId = `p3394-receipt-${randomUUID()}`;
});

afterEach(async () => {
  const { userRoot } = await import('../../../../src/main/paths');
  await fs.rm(userRoot(userId), { recursive: true, force: true });
});

function baseInput() {
  return {
    receiptId: 'receipt-1',
    executionId: 'execution-1',
    sourceSessionId: 'gconv-source',
    sourceContextId: 'ctx-source',
    targetSessionId: 'gmember-target',
    targetContextId: 'ctx-target',
    reusedRefs: ['artifact:one'],
    omittedRefs: ['context:private'],
    permissionMode: 'workspace-write',
    allowedScopes: ['workspace', 'artifacts'],
    boundary: 'real' as const,
  };
}

const expectedTarget = {
  sessionId: 'gmember-target',
  contextId: 'ctx-target',
};

describe('P3394 context reuse receipts', () => {
  it('prepares an atomic user-local receipt at the execution path', async () => {
    const {
      contextReuseReceiptPath,
      prepareReceipt,
    } = await import('../../../../src/main/features/p3394/context-reuse-receipt');

    const receipt = await prepareReceipt(userId, baseInput(), expectedTarget);
    const receiptPath = contextReuseReceiptPath(userId, 'execution-1');
    const stored = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    const entries = await fs.readdir(path.dirname(receiptPath));

    expect(receipt).toMatchObject({
      receiptId: 'receipt-1',
      executionId: 'execution-1',
      targetSessionId: 'gmember-target',
      targetContextId: 'ctx-target',
      status: 'prepared',
      boundary: 'real',
    });
    expect(receipt.createdAt).toEqual(expect.any(String));
    expect(stored).toEqual(receipt);
    expect(receiptPath).toContain(
      path.join(userId, 'local', 'kstar', 'executions', 'execution-1', 'context-reuse-receipt.json'),
    );
    expect(entries).toEqual(['context-reuse-receipt.json']);
  });

  it('deduplicates and redacts prompt/token-like references before persistence', async () => {
    const { prepareReceipt } = await import(
      '../../../../src/main/features/p3394/context-reuse-receipt'
    );
    const input = baseInput();
    input.reusedRefs = [
      'artifact:one',
      'artifact:one',
      'prompt=do not persist this private instruction',
      'token=sk-this-is-a-sensitive-token-value',
    ];
    input.omittedRefs = [
      'system_prompt: hidden policy text',
      'system_prompt: hidden policy text',
    ];
    input.allowedScopes = ['workspace', 'workspace', 'artifacts'];

    const receipt = await prepareReceipt(userId, input, expectedTarget);
    const serialized = JSON.stringify(receipt);

    expect(receipt.reusedRefs).toHaveLength(3);
    expect(receipt.omittedRefs).toHaveLength(1);
    expect(receipt.allowedScopes).toEqual(['workspace', 'artifacts']);
    expect(serialized).not.toContain('private instruction');
    expect(serialized).not.toContain('sensitive-token-value');
    expect(serialized).not.toContain('hidden policy text');
    expect(serialized).toContain('[REDACTED]');
  });

  it('redacts colon-form token, key, and bearer values without masking normal words', async () => {
    const { prepareReceipt } = await import(
      '../../../../src/main/features/p3394/context-reuse-receipt'
    );
    const input = baseInput();
    input.reusedRefs = [
      'token: colon-token-secret',
      'AcCeSs_ToKeN: mixed-access-secret',
      'api_key: colon-api-key-secret',
      'Authorization: Bearer bearer-secret-value',
      'artifact:token-usage-summary',
    ];
    input.omittedRefs = [
      'ToKeN: mixed-token-secret',
      'ACCESS_TOKEN: upper-access-secret',
      'API_KEY: upper-api-key-secret',
      'aUtHoRiZaTiOn: bEaReR mixed-bearer-secret',
      'note: authorization design overview',
    ];

    const receipt = await prepareReceipt(userId, input, expectedTarget);
    const serialized = JSON.stringify(receipt);

    for (const secret of [
      'colon-token-secret',
      'mixed-access-secret',
      'colon-api-key-secret',
      'bearer-secret-value',
      'mixed-token-secret',
      'upper-access-secret',
      'upper-api-key-secret',
      'mixed-bearer-secret',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(receipt.reusedRefs).toContain('artifact:token-usage-summary');
    expect(receipt.omittedRefs).toContain('note: authorization design overview');
    expect(serialized.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(8);
  });

  it('preserves bounded permission scope identifiers with namespace separators', async () => {
    const { prepareReceipt } = await import(
      '../../../../src/main/features/p3394/context-reuse-receipt'
    );
    const input = baseInput();
    input.allowedScopes = ['workspace:read', 'artifact/write'];

    const receipt = await prepareReceipt(userId, input, expectedTarget);

    expect(receipt.allowedScopes).toEqual(['workspace:read', 'artifact/write']);
  });

  it('rejects target session or context mismatches before writing', async () => {
    const {
      contextReuseReceiptPath,
      prepareReceipt,
    } = await import('../../../../src/main/features/p3394/context-reuse-receipt');

    await expect(prepareReceipt(userId, baseInput(), {
      sessionId: 'gmember-other',
      contextId: 'ctx-target',
    })).rejects.toThrow(/target session mismatch/i);
    await expect(prepareReceipt(userId, baseInput(), {
      sessionId: 'gmember-target',
      contextId: 'ctx-other',
    })).rejects.toThrow(/target context mismatch/i);
    await expect(fs.access(contextReuseReceiptPath(userId, 'execution-1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps source, target, refs, permission, and scopes immutable on completion', async () => {
    const {
      completeReceipt,
      prepareReceipt,
      readReceipt,
    } = await import('../../../../src/main/features/p3394/context-reuse-receipt');
    await prepareReceipt(userId, baseInput(), expectedTarget);

    await expect(completeReceipt(userId, 'execution-1', {
      status: 'completed',
      targetContextId: 'ctx-other',
    })).rejects.toThrow(/target context.*immutable/i);
    await expect(completeReceipt(userId, 'execution-1', {
      status: 'completed',
      reusedRefs: ['artifact:two'],
    })).rejects.toThrow(/reused refs.*immutable/i);

    await expect(readReceipt(userId, 'execution-1')).resolves.toMatchObject({
      status: 'prepared',
      targetContextId: 'ctx-target',
      reusedRefs: ['artifact:one'],
    });
  });

  it('completes once and records bounded comparison execution ids', async () => {
    const {
      completeReceipt,
      prepareReceipt,
      readReceipt,
    } = await import('../../../../src/main/features/p3394/context-reuse-receipt');
    await prepareReceipt(userId, baseInput(), expectedTarget);

    const completed = await completeReceipt(userId, 'execution-1', {
      status: 'completed',
      targetSessionId: 'gmember-target',
      targetContextId: 'ctx-target',
      baselineExecutionId: 'execution-baseline',
      treatmentExecutionId: 'execution-treatment',
    });

    expect(completed).toMatchObject({
      status: 'completed',
      baselineExecutionId: 'execution-baseline',
      treatmentExecutionId: 'execution-treatment',
    });
    expect(completed.completedAt).toEqual(expect.any(String));
    await expect(readReceipt(userId, 'execution-1')).resolves.toEqual(completed);
    await expect(completeReceipt(userId, 'execution-1', {
      status: 'degraded',
    })).rejects.toThrow(/already finalized/i);
  });

  it('rejects prepared or unknown values as completion statuses', async () => {
    const { completeReceipt, prepareReceipt } = await import(
      '../../../../src/main/features/p3394/context-reuse-receipt'
    );
    await prepareReceipt(userId, baseInput(), expectedTarget);

    await expect(completeReceipt(userId, 'execution-1', {
      status: 'prepared',
    } as any)).rejects.toThrow(/completion status/i);
    await expect(completeReceipt(userId, 'execution-1', {
      status: 'unknown',
    } as any)).rejects.toThrow(/completion status/i);
  });
});
