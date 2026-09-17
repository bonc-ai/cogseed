/**
 * transcript_query_rewrite — 检索前 query 同义改写（方案 §五 P2-3 / §8.1-9）
 *
 * 守的不变量：可开关、只改低中风险、口癖（删字类）不参与、高危词一个字不改。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { describeRewrite, rewriteQuery } from '../../../src/main/features/transcript_query_rewrite';
import { upsertEntry, setQueryRewrite, isQueryRewriteEnabled } from '../../../src/main/features/transcript_glossary';

let uid = '';
beforeEach(() => {
  uid = `u_qrw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
});

describe('改写行为', () => {
  it('命中词表的错形 → 改写成正确写法，并reporting改了哪些词', () => {
    upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed' });
    const result = rewriteQuery(uid, 'coxy 的课程进度');
    expect(result.changed).toBe(true);
    expect(result.rewritten).toBe('Cogseed 的课程进度');
    expect(result.applied).toEqual([{ wrong: 'coxy', correct: 'Cogseed', count: 1 }]);
    expect(describeRewrite(result)).toBe('coxy → Cogseed');
  });

  it('高危词不动：搜 model 就是搜 model（不许偷偷改成 Moodle）', () => {
    upsertEntry(uid, { wrong: 'model', correct: 'Moodle', riskLevel: 'high' });
    const result = rewriteQuery(uid, 'model 怎么配');
    expect(result.changed).toBe(false);
    expect(result.rewritten).toBe('model 怎么配');
  });

  it('口癖（action=delete）不参与改写：把 query 删字没有意义', () => {
    upsertEntry(uid, { wrong: '嗯', action: 'delete', kind: 'filler' });
    const result = rewriteQuery(uid, '嗯 这个方案');
    expect(result.changed).toBe(false);
  });

  it('词表为空 / query 为空 / 开关关闭 → 原样返回', () => {
    expect(rewriteQuery(uid, '随便搜点东西').changed).toBe(false);
    expect(rewriteQuery(uid, '   ').changed).toBe(false);
    upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed' });
    expect(rewriteQuery(uid, 'coxy', { enabled: false }).changed).toBe(false);
    expect(rewriteQuery(uid, 'coxy').changed).toBe(true);
  });

  it('上下文黑名单仍然生效（误伤保护在检索侧一样管用）', () => {
    upsertEntry(uid, { wrong: 'fuping', correct: '傅平', contextDeny: ['扶贫'] });
    expect(rewriteQuery(uid, '扶贫办 fuping').changed).toBe(false);
    expect(rewriteQuery(uid, '同事 fuping').changed).toBe(true);
  });
});

describe('开关持久化', () => {
  it('默认关，可显式打开并读回', () => {
    expect(isQueryRewriteEnabled(uid)).toBe(false);
    expect(setQueryRewrite(uid, true)).toBe(true);
    expect(isQueryRewriteEnabled(uid)).toBe(true);
    expect(setQueryRewrite(uid, false)).toBe(false);
    expect(isQueryRewriteEnabled(uid)).toBe(false);
  });
});
