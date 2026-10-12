/**
 * 贡献会话：跨账号隔离与结论作废。
 *
 * 两条都是安全面，各自有具体的失败后果：
 * - 跨账号取到会话 = 一个账号能拿到另一个账号正在准备提交的内容；
 * - 补齐后不作废旧结论 = 拿旧的"通过"结论发了新内容（`C-FR-004c` 禁止沿用）。
 *
 * 用真实临时目录建 staging：会话销毁时要真的删掉副本，mock 会把这件事假设掉。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createSession, getSession, endSession, endAllSessions, invalidate, _resetForTest,
} from '../../../../src/main/features/contribution/session';
import type { ContributionStaging } from '../../../../src/main/features/contribution/staging';

const made: string[] = [];
function fakeStaging(token: string): ContributionStaging {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `contrib-sess-${token}-`));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# demo');
  made.push(dir);
  return { dir, sourceSkillId: 'demo', token };
}

beforeEach(() => { _resetForTest(); });
afterEach(() => {
  _resetForTest();
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('跨账号隔离', () => {
  it('另一个 uid 用同一个 token 取不到会话', () => {
    const s = createSession('alice', fakeStaging('aaaaaaaaaaaa'));
    expect(getSession('alice', s.token)).not.toBeNull();
    expect(getSession('bob', s.token)).toBeNull();
  });

  it('endAllSessions 只终止该账号的会话', async () => {
    createSession('alice', fakeStaging('aaaaaaaaaaaa'));
    const bobSession = createSession('bob', fakeStaging('bbbbbbbbbbbb'));
    const ended = await endAllSessions('alice');
    expect(ended).toBe(1);
    expect(getSession('alice', 'aaaaaaaaaaaa')).toBeNull();
    expect(getSession('bob', bobSession.token)).not.toBeNull();
  });
});

describe('会话结束时销毁副本', () => {
  it('endSession 会中止在途上传', async () => {
    const staging = fakeStaging('abababababab');
    const session = createSession('alice', staging);
    session.uploadController = new AbortController();
    const signal = session.uploadController.signal;
    await endSession('alice', staging.token);
    expect(signal.aborted).toBe(true);
  });

  it('endSession 删掉副本目录 —— 副本可能含已填入的真实声明内容', async () => {
    const staging = fakeStaging('cccccccccccc');
    createSession('alice', staging);
    expect(fs.existsSync(staging.dir)).toBe(true);
    await endSession('alice', staging.token);
    expect(fs.existsSync(staging.dir)).toBe(false);
  });

  it('endSession 幂等 —— 重复调用不抛错', async () => {
    const staging = fakeStaging('dddddddddddd');
    createSession('alice', staging);
    await endSession('alice', staging.token);
    await expect(endSession('alice', staging.token)).resolves.toBeUndefined();
  });

  it('endAllSessions 删掉该账号全部副本', async () => {
    const a = fakeStaging('eeeeeeeeeeee');
    const b = fakeStaging('ffffffffffff');
    createSession('alice', a);
    createSession('alice', b);
    expect(await endAllSessions('alice')).toBe(2);
    expect(fs.existsSync(a.dir)).toBe(false);
    expect(fs.existsSync(b.dir)).toBe(false);
  });
});

describe('副本变化后作废既有结论', () => {
  it('invalidate 同时清掉准入结论与已确认预览', () => {
    const s = createSession('alice', fakeStaging('111111111111'));
    s.admission = { outcome: 'pass' } as never;
    s.confirmedPreview = { digest: 'x', files: [], totalBytes: 0 };
    invalidate(s);
    expect(s.admission).toBeNull();
    expect(s.confirmedPreview).toBeNull();
  });
});
