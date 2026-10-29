import { describe, it, expect } from 'vitest';

import {
  buildDelta,
  deltaFingerprint,
  deltaIdempotencyKey,
  validateDelta,
} from '../../../../src/main/features/cognition_kernel/delta';

describe('cognition_kernel/delta — 任何改动都是一个变更集', () => {
  it('幂等键按"槽位"稳定：同槽位恒同键，换字段/来源就变', () => {
    const a = deltaIdempotencyKey({ origin: 'gap', home: 'personal_fact', groupId: 'g1', fieldName: '银行卡号' });
    const b = deltaIdempotencyKey({ origin: 'gap', home: 'personal_fact', groupId: 'g1', fieldName: '银行卡号' });
    const c = deltaIdempotencyKey({ origin: 'gap', home: 'personal_fact', groupId: 'g1', fieldName: '审批人' });
    const d = deltaIdempotencyKey({ origin: 'kstar', home: 'personal_fact', groupId: 'g1', fieldName: '银行卡号' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a.startsWith('delta-')).toBe(true);
  });

  it('用户手改 → applied；系统提议 → proposed', () => {
    const user = buildDelta({
      op: 'add',
      target: { home: 'personal_fact', groupId: 'g1', fieldName: '银行卡号' },
      origin: 'user',
      after: '6217-0000-0000-1234',
      now: '2026-10-02T00:00:00.000Z',
    });
    const system = buildDelta({
      op: 'add',
      target: { home: 'personal_fact', groupId: 'g1', fieldName: '审批人' },
      origin: 'gap',
      after: '示例审批人',
      now: '2026-10-02T00:00:00.000Z',
    });
    expect(user.status).toBe('applied');
    expect(system.status).toBe('proposed');
  });

  it('内容指纹忽略空白差异', () => {
    expect(deltaFingerprint(' 我在  开源项目组 ')).toBe(deltaFingerprint('我在 开源项目组'));
  });

  it('合法 delta 通过校验', () => {
    const delta = buildDelta({
      op: 'add',
      target: { home: 'personal_fact', groupId: 'g1', fieldName: '银行卡号' },
      origin: 'gap',
      after: '6217',
      evidenceRefs: [{ kind: 'session', id: 's1' }],
      now: '2026-10-02T00:00:00.000Z',
    });
    const result = validateDelta(delta);
    expect(result.ok).toBe(true);
  });

  it.each([
    ['缺 deltaId', { deltaId: '' }],
    ['op 非法', { op: 'merge' }],
    ['origin 非法', { origin: 'magic' }],
    ['status 非法', { status: 'pending' }],
    ['home 非法', { target: { home: 'nowhere' } }],
    ['幂等键前缀错误', { idempotencyKey: 'x-1' }],
    ['缺 evidenceRefs', { evidenceRefs: undefined }],
    ['非删除操作没有 after', { op: 'update', after: '   ' }],
    ['after 超长', { after: 'x'.repeat(2001) }],
  ])('拒绝：%s', (_label, patch) => {
    const base = buildDelta({
      op: 'add',
      target: { home: 'personal_fact', groupId: 'g1', fieldName: 'f' },
      origin: 'gap',
      after: 'v',
      evidenceRefs: [],
      now: '2026-10-02T00:00:00.000Z',
    });
    const result = validateDelta({ ...base, ...patch });
    expect(result.ok).toBe(false);
  });

  it('删除操作允许 after 为空', () => {
    const delta = buildDelta({
      op: 'remove',
      target: { home: 'personal_fact', objectId: 'v1' },
      origin: 'user',
      after: null,
      now: '2026-10-02T00:00:00.000Z',
    });
    expect(validateDelta(delta).ok).toBe(true);
  });
});
