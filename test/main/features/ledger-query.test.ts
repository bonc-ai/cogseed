import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir = '';
let previousRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-ledger-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('messaging delivery ledger external-id lookup', () => {
  async function seed(uid: string): Promise<void> {
    const { beginDelivery, deliveryKey } = await import('../../../src/main/features/messaging/ledger');
    await beginDelivery(uid, {
      key: deliveryKey('bot-1', 'src-1'),
      instanceId: 'bot-1',
      externalChatId: 'oc_1',
      sourceMessageId: 'src-1',
      textHash: 'hash',
      text: 'hello',
      idempotencyKey: 'idem-1',
    });
  }

  it('finds a finished delivery by its external delivery id', async () => {
    const ledger = await import('../../../src/main/features/messaging/ledger');
    await seed('u-1');
    await ledger.finishDelivery('u-1', ledger.deliveryKey('bot-1', 'src-1'), {
      status: 'sent',
      externalDeliveryId: 'om_9',
    });
    const found = await ledger.getDeliveryByExternalId('u-1', 'bot-1', 'om_9');
    expect(found).toMatchObject({ instanceId: 'bot-1', externalDeliveryId: 'om_9', externalChatId: 'oc_1', status: 'sent' });
  });

  it('returns null for unknown or other-instance delivery ids', async () => {
    const ledger = await import('../../../src/main/features/messaging/ledger');
    await seed('u-1');
    await ledger.finishDelivery('u-1', ledger.deliveryKey('bot-1', 'src-1'), {
      status: 'sent',
      externalDeliveryId: 'om_9',
    });
    expect(await ledger.getDeliveryByExternalId('u-1', 'bot-1', 'om_unknown')).toBeNull();
    expect(await ledger.getDeliveryByExternalId('u-1', 'bot-2', 'om_9')).toBeNull();
  });

  it('returns null for blank or oversized ids without touching the file', async () => {
    const ledger = await import('../../../src/main/features/messaging/ledger');
    expect(await ledger.getDeliveryByExternalId('u-1', 'bot-1', '  ')).toBeNull();
    expect(await ledger.getDeliveryByExternalId('u-1', 'bot-1', 'x'.repeat(600))).toBeNull();
  });
});
