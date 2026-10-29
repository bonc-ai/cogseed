import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Q1 过期 → Q2 重开（P3）：旧的 5 分钟提示计时器属于已经过期的那次来访。
 *
 * 真实缺陷：重开只替换 marker/pending，旧 timer 仍按「同 key」留在主进程内存里；
 * 到点后它看到新的 waiting marker，就会给**新**来访提前发一句「稍后回复」，
 * 同时让 relay-pump 对新来访的 schedule 因 key 去重而排不进来。
 */
const U = 'cs_receiver';
const PEER = 'cs_alice';
const CID = 'a2a-0123456789abcdef0301';
const OLD_MSG = 'amsg-nudge-old';
const NEW_MSG = 'amsg-nudge-new';
const OLD_TEXT = '过期之前的问题';
const NEW_TEXT = '过期之后重新问的问题';
const MINUTE = 60 * 1000;

let tmp: string;
let previous: string | undefined;

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-nudge-reopen-')));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
  vi.resetModules();
  await seedContact();
});

afterEach(async () => {
  const { resetReceptionNudges } = await import('../../../../src/main/features/a2a/reception-nudge');
  resetReceptionNudges();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function seedContact(): Promise<void> {
  const { writeJson } = await import('../../../../src/main/storage');
  const { userContactsFile } = await import('../../../../src/main/paths');
  await writeJson(userContactsFile(U), {
    version: 1,
    contacts: [{ userId: PEER, name: 'Alice', addedAt: new Date().toISOString() }],
  });
}

describe('a2a reception › nudge ownership across an expired reopen', () => {
  it('cancels the expired visit nudge so the reopened visit is not nudged early', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const service = await import('../../../../src/main/features/a2a/reception-service');
    const nudges = await import('../../../../src/main/features/a2a/reception-nudge');
    const send = vi.fn(async () => ({ messageId: 'nudge-ack' }));

    // Q1 已经超过 10 分钟（但旧实现仍可能留着一个排队中的提示计时器）。
    const oldReceivedAt = new Date(Date.now() - 11 * MINUTE).toISOString();
    await expect(service.handleInboundQuestion(U, {
      messageId: OLD_MSG,
      conversationId: CID,
      fromAccount: PEER,
      text: OLD_TEXT,
      createdAt: oldReceivedAt,
    })).resolves.toMatchObject({ accepted: true, outcome: { awaitingConfirmation: true } });
    nudges.scheduleReceptionNudge(U, CID, PEER, { send, delayMs: 5 * MINUTE });
    expect(vi.getTimerCount()).toBe(1);

    // 同 CID 的新问题重开这次来访；旧 visit 的 timer 必须被撤销。
    const newReceivedAt = new Date().toISOString();
    await expect(service.handleInboundQuestion(U, {
      messageId: NEW_MSG,
      conversationId: CID,
      fromAccount: PEER,
      text: NEW_TEXT,
      createdAt: newReceivedAt,
    })).resolves.toMatchObject({ accepted: true, outcome: { awaitingConfirmation: true } });
    expect(vi.getTimerCount()).toBe(0);

    // 新 visit 的提示重新按自己的 5 分钟窗口排队，而不是继承旧 timer。
    vi.useRealTimers();
    nudges.scheduleReceptionNudge(U, CID, PEER, { send, delayMs: 30 });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      to: PEER,
      conversationId: CID,
      kind: 'answer',
    }));
  });
});
