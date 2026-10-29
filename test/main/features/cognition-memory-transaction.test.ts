/** 认知记忆事务边界：同键嵌套 fail-fast，独立并发正常排队；非法用户 ID
 * 在建锁前拒绝。整文件回滚与后续事务写串行，不能覆盖已排队的写入。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let tmpDir: string;
let prevRoot: string | undefined;
const UID = 'uTxn';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-cogmem-txn-'));
  prevRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

describe('cognition-memory transaction › 重入 fail-fast', () => {
  it('同一用户的嵌套事务立即抛错而不是永久挂起', async () => {
    const { withCognitionMemoryTransaction } = await import('../../../src/main/features/cognition-memory-transaction');
    let innerError: Error | undefined;
    await withCognitionMemoryTransaction(UID, async () => {
      try {
        await withCognitionMemoryTransaction(UID, async () => 'unreachable');
      } catch (error) {
        innerError = error as Error;
      }
    });
    expect(innerError).toBeInstanceOf(Error);
    expect(innerError!.message).toContain('re-entered');
  });

  it('不同用户的嵌套事务不受同键 fail-fast 影响', async () => {
    const { withCognitionMemoryTransaction } = await import('../../../src/main/features/cognition-memory-transaction');
    const seen: string[] = [];
    await withCognitionMemoryTransaction(UID, async () => {
      await withCognitionMemoryTransaction('uTxnOther', async () => {
        seen.push('inner');
      });
      seen.push('outer');
    });
    expect(seen).toEqual(['inner', 'outer']);
  });

  it('独立并发（非嵌套）的事务正常排队完成，不触发 fail-fast', async () => {
    const { withCognitionMemoryTransaction } = await import('../../../src/main/features/cognition-memory-transaction');
    const order: string[] = [];
    const first = withCognitionMemoryTransaction(UID, async () => {
      order.push('first-start');
      await new Promise((resolve) => setTimeout(resolve, 50));
      order.push('first-end');
    });
    const second = withCognitionMemoryTransaction(UID, async () => {
      order.push('second-start');
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });
});

describe('cognition-memory transaction › 入口校验', () => {
  it.each(['bad/id', 'space id', '', 'x'.repeat(81)])('非法 userId %j 在建锁前抛错', async (badId) => {
    const { withCognitionMemoryTransaction } = await import('../../../src/main/features/cognition-memory-transaction');
    let ran = false;
    await expect(withCognitionMemoryTransaction(badId, async () => {
      ran = true;
    })).rejects.toThrow('invalid cognition-memory transaction user id');
    expect(ran).toBe(false);
  });

  it('合法 userId 正常进入事务并通过租约断言', async () => {
    const txn = await import('../../../src/main/features/cognition-memory-transaction');
    let asserted = false;
    await txn.withCognitionMemoryTransaction(UID, (transaction) => {
      txn.assertCognitionMemoryTransaction(transaction, UID);
      asserted = true;
    });
    expect(asserted).toBe(true);
  });
});

describe('cognition-memory transaction › 回滚不得覆盖已排队的事务化写', () => {
  it('cognition 坏档触发整文件回滚时，排队中的事务化 MEMORY.md 写入应保留', async () => {
    const memoryFile = path.join(tmpDir, UID, 'cloud', 'memory', 'MEMORY.md');
    const cognitionFile = path.join(tmpDir, UID, 'cloud', 'cognition', 'assets.json');

    // ① 认知 store 坏档：readStore 只放 ENOENT → invalidate 失败 → 触发回滚
    fs.mkdirSync(path.dirname(cognitionFile), { recursive: true });
    fs.writeFileSync(cognitionFile, '{ "broken": ', 'utf8');

    // ② MEMORY.md：一条带 cognition_asset source 的记录（remove 产出
    //    detachedCognitionSourceIds → 走 invalidate → 撞上坏档 → 回滚）
    const text = '一条绑定了认知资产的旧记忆';
    const header = {
      recordId: 'mem_abcdef0123456789',
      contentSha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
      independent: false,
      sources: [{ kind: 'cognition_asset', sourceId: 'ca_txn_asset_1' }],
    };
    fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
    fs.writeFileSync(memoryFile, `<!-- cogseed-agent-memory:v1 ${JSON.stringify(header)} -->\n${text}`, 'utf8');

    const memory = await import('../../../src/main/features/memory');

    // ③ removeEntryTransactional：mutation 落盘 → invalidate 撞坏档 → 回滚
    const removePromise = memory.removeEntryTransactional(UID, 'memory', text).then(
      (r) => r,
      (e: unknown) => ({ thrown: String((e as Error)?.message || e) }),
    );

    // ④ 等 mutation 已落盘（记录被删）、流程仍卡在 invalidate/回滚窗口
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!fs.readFileSync(memoryFile, 'utf8').includes(text)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // ⑤ 并发写走事务通道（修复前 session 导入器在这里裸调 addEntry）
    const addRes = await memory.addEntryTransactional(UID, 'memory', '导入器并发写入的记忆');
    expect(addRes.ok).toBe(true);

    await removePromise;
    const after = fs.readFileSync(memoryFile, 'utf8');
    // 核心断言：排队的事务化写不被整文件回滚静默覆盖
    expect(after.includes('导入器并发写入的记忆')).toBe(true);
  });
});
