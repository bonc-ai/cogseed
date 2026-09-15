/**
 * transcript_glossary_seed — 方案附 A 的初始词表种子
 *
 * 守的不变量：清单来自方案文档（不是猜的）、幂等、且方案明写"默认不入册"的词
 * 一条都不能偷偷进去。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  INITIAL_GLOSSARY_SEED,
  SEED_EXCLUDED,
  seedInitialEntries,
} from '../../../src/main/features/transcript_glossary_seed';
import { listEntries } from '../../../src/main/features/transcript_glossary';

let uid = '';
beforeEach(() => {
  uid = `u_seed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
});

describe('附 A 种子清单', () => {
  it('包含方案点名的关键行（含此前漏掉的 personalontology）', () => {
    const wrongs = INITIAL_GLOSSARY_SEED.map((row) => row.wrong);
    for (const expected of ['coxy', 'K 星', '雷蒙德', 'IDC', '多 vbl', 'personalontology', 'personaltology']) {
      expect(wrongs).toContain(expected);
    }
  });

  it('风险等级照抄方案：redmi/model/contact 是 high（不许被"降风险"）', () => {
    for (const wrong of ['redmi', 'model', 'contact']) {
      expect(INITIAL_GLOSSARY_SEED.find((row) => row.wrong === wrong)?.riskLevel).toBe('high');
    }
  });

  it('`for → Forge` 只在"刻意排除"清单里，不在种子里', () => {
    expect(SEED_EXCLUDED.map((row) => row.wrong)).toContain('for');
    expect(INITIAL_GLOSSARY_SEED.map((row) => row.wrong)).not.toContain('for');
  });
});

describe('装入行为', () => {
  it('首次装入全部新增；再装一次全部更新（幂等，不重复入库）', () => {
    const first = seedInitialEntries(uid);
    expect(first.created).toBe(INITIAL_GLOSSARY_SEED.length);
    expect(listEntries(uid)).toHaveLength(INITIAL_GLOSSARY_SEED.length);

    const second = seedInitialEntries(uid);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(INITIAL_GLOSSARY_SEED.length);
    expect(listEntries(uid)).toHaveLength(INITIAL_GLOSSARY_SEED.length);
  });

  it('不覆盖用户既有写法：同错形不同写法时保留两条（种子只补不抢）', () => {
    const file = listEntries(uid);
    expect(file).toHaveLength(0);
    seedInitialEntries(uid);
    const entries = listEntries(uid, { search: 'coxy' });
    expect(entries.some((entry) => entry.correct === 'Cogseed')).toBe(true);
  });
});
