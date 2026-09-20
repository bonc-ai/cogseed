/**
 * transcript_recall — 多路召回层
 *
 * 重点覆盖（对齐 AGENTS「测业务不变量、恢复路径、文本陷阱」）：
 *   - **结构性安全性质**：召回目标只能是词表已有词条（不可能发明新概念）、
 *     `confidence` 恒 < 1（模糊候选不得被当精确命中用）；
 *   - 四条护栏**与精确扫描同语义**（边界 / 语境黑白名单 / 保护区域 / 作用域）；
 *   - 阈值分层是实测定出来的：强模糊档可 `suggest`，弱通道（k42/coxy 一类）
 *     只能 `review`；`trapWords` 与"脱域"一律降级；
 *   - 中文音近的接入口 `extraPhonetic`（零依赖下的拼音表挂点）；
 *   - `stats.residual` 必须把"兜不住的形态"报出来，而不是假装覆盖；
 *   - 重叠消解：长 span 优先。
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MIN_SIMILARITY,
  DEFAULT_WEAK_SIMILARITY,
  MAX_RECALL_CONFIDENCE,
  editDistance,
  normalizeKey,
  phoneticKey,
  recallCandidates,
  similarity,
} from '../../../src/main/features/transcript_recall';
import {
  defaultBoundary,
  type GlossaryEntry,
  type GlossaryKind,
  type RiskLevel,
} from '../../../src/main/features/transcript_glossary';

let seq = 0;
function entry(over: Partial<GlossaryEntry> & { wrong: string; correct: string }): GlossaryEntry {
  seq += 1;
  const kind: GlossaryKind = over.kind ?? 'product';
  const riskLevel: RiskLevel = over.riskLevel ?? 'low';
  return {
    id: over.id ?? `g_r${seq}`,
    wrong: over.wrong,
    correct: over.correct,
    action: over.action ?? 'replace',
    kind,
    riskLevel,
    boundary: over.boundary ?? defaultBoundary(over.wrong, over.action ?? 'replace'),
    contextDeny: over.contextDeny ?? [],
    contextAllow: over.contextAllow ?? [],
    scope: over.scope ?? { docIds: [], scenarioTags: [], global: true },
    freq: over.freq ?? 0,
    source: over.source ?? 'manual',
    status: over.status ?? 'active',
    ownerScope: over.ownerScope ?? 'personal',
    replacedIn: over.replacedIn ?? [],
    createdBy: over.createdBy ?? 'manual',
    createdAt: over.createdAt ?? 1,
    updatedAt: over.updatedAt ?? 1,
    lastVerifiedAt: over.lastVerifiedAt ?? 1,
  };
}

/** 项目真实种子里的几条代表性词条。 */
const cogseed = entry({ wrong: 'coxy', correct: 'Cogseed' });
const cogseedLong = entry({ wrong: 'cogseed', correct: 'Cogseed', riskLevel: 'high' });
const kstar = entry({ wrong: 'K star', correct: 'KSTAR', kind: 'term' });
const k4 = entry({ wrong: 'K4', correct: 'KSTAR', kind: 'term' });
const raymond = entry({ wrong: '雷蒙德', correct: 'Raymond', kind: 'people' });
const mesh = entry({ wrong: 'mesh seed', correct: 'MeshSeed' });
const SEED = [cogseed, cogseedLong, kstar, k4, raymond, mesh];

/** 与 09-14 手工清理版附记一致的域概念（本次会议确实在讲这些）。 */
const DOMAIN = ['Cogseed', 'KSTAR', 'Raymond', 'MeshSeed'];

describe('归一化与音形骨架', () => {
  it('normalizeKey 抹掉分隔符与大小写：K-STAR / K star / kstar 视为同一键', () => {
    expect(normalizeKey('K-STAR')).toBe('kstar');
    expect(normalizeKey('K star')).toBe('kstar');
    expect(normalizeKey('kstar')).toBe('kstar');
    expect(normalizeKey('多 vbl')).toBe('多vbl');
  });

  it('phoneticKey 归并辅音、元音占位、压缩连续重复', () => {
    // c→k, o→a, g→g, s→s, e→a, ee→a, d→d
    expect(phoneticKey('Cogseed')).toBe('kagsad');
    // x→ks，y 视作元音
    expect(phoneticKey('coxy')).toBe('kaksa');
    // 数字原样保留（k42 / K4 的兜底靠它）
    expect(phoneticKey('k42')).toBe('k42');
  });

  it('中文未注入拼音时原样保留（不退化成空骨架造成假命中）', () => {
    expect(phoneticKey('雷蒙德')).toBe('雷蒙德');
    expect(phoneticKey('雷蒙德')).not.toBe('');
  });

  it('editDistance / similarity 边界正确', () => {
    expect(editDistance('', '')).toBe(0);
    expect(editDistance('abc', '')).toBe(3);
    expect(editDistance('cogsed', 'cogseed')).toBe(1);
    expect(similarity('cogsed', 'cogseed')).toBeCloseTo(1 - 1 / 7, 5);
    expect(similarity('', '')).toBe(1);
  });
});

describe('通道分层（阈值来自实测，不是拍的）', () => {
  it('归一化通道：K-STAR 命中词条 `K star`，相似度 1', () => {
    const r = recallCandidates('这块用的是 K-STAR 记录', SEED, { domainTerms: DOMAIN });
    const hit = r.candidates.find((c) => c.correct === 'KSTAR');
    expect(hit).toBeDefined();
    expect(hit?.channel).toBe('normalized');
    expect(hit?.similarity).toBe(1);
    expect(hit?.wrong).toBe('K-STAR');
  });

  it('强模糊档（字面 0.857 / 音形 1.0）走 phonetic 通道且可 suggest', () => {
    const g = entry({ wrong: 'Cogseed', correct: 'Cogseed' });
    const r = recallCandidates('这里写成了 cogsed 的形态', [g], { domainTerms: ['Cogseed'] });
    const hit = r.candidates.find((c) => c.wrong === 'cogsed');
    expect(hit).toBeDefined();
    // 音形骨架比字面更近（cogsed 与 Cogseed 骨架相同）→ 取更强者，这是有意的
    expect(hit?.channel).toBe('phonetic');
    expect(hit?.similarity).toBeGreaterThanOrEqual(DEFAULT_MIN_SIMILARITY);
    expect(hit?.disposition).toBe('suggest');
    // 但相似度再高也不等于精确：confidence 仍 < 1
    expect(hit?.confidence).toBeLessThan(1);
  });

  it('k42 → K4 落在**弱通道**（0.667）：能召回，但只能 review', () => {
    const r = recallCandidates('它被转成了 k42 之类的东西', [k4], { domainTerms: ['KSTAR'] });
    const hit = r.candidates.find((c) => c.wrong === 'k42');
    expect(hit).toBeDefined();
    expect(hit?.channel).toBe('weak');
    expect(hit?.similarity).toBeLessThan(DEFAULT_MIN_SIMILARITY);
    expect(hit?.similarity).toBeGreaterThanOrEqual(DEFAULT_WEAK_SIMILARITY);
    // 弱通道**永远**不得被升级为建议
    expect(hit?.disposition).toBe('review');
  });

  it('weakSimilarity=1 可整体关闭弱通道', () => {
    const r = recallCandidates('它被转成了 k42 之类的东西', [k4], {
      domainTerms: ['KSTAR'],
      weakSimilarity: 1,
    });
    expect(r.candidates).toHaveLength(0);
  });

  it('roadmap → Raymond 相似度 0：任何阈值都召回不到（主因是覆盖面，不是算法）', () => {
    const r = recallCandidates('今天过一下 roadmap 的规划', [raymond], {
      domainTerms: ['Raymond'],
      weakSimilarity: 0.1,
    });
    expect(r.candidates).toHaveLength(0);
    // 且它必须进残余清单——提醒"这类只能靠入册或域先验"
    expect(r.stats.residual.some((x) => x.surface === 'roadmap')).toBe(true);
  });
});

describe('结构性安全性质', () => {
  it('confidence 恒 < 1：模糊候选不可能被当精确命中', () => {
    const r = recallCandidates('K-STAR 和 cogsed 都出现', [kstar, cogseedLong], {
      domainTerms: ['KSTAR', 'Cogseed'],
    });
    expect(r.candidates.length).toBeGreaterThan(0);
    for (const c of r.candidates) {
      expect(c.confidence).toBeLessThan(1);
      expect(c.confidence).toBeLessThanOrEqual(MAX_RECALL_CONFIDENCE);
    }
  });

  it('召回目标只能是词表已有词条：不可能发明新概念', () => {
    const allowed = new Set(SEED.map((e) => e.correct));
    const r = recallCandidates(
      '文本里有 K-STAR、mesh seed、cogseedgarbage、蓝翔挖掘机',
      SEED,
      { domainTerms: DOMAIN },
    );
    for (const c of r.candidates) expect(allowed.has(c.correct)).toBe(true);
  });

  it('脱域一律降级 review（roadmap 类误替换的防线）', () => {
    const g = entry({ wrong: 'Cogseed', correct: 'Cogseed' });
    const inDomain = recallCandidates('写成了 cogsed', [g], { domainTerms: ['Cogseed'] });
    const offDomain = recallCandidates('写成了 cogsed', [g], { domainTerms: [] });
    expect(inDomain.candidates[0].disposition).toBe('suggest');
    expect(offDomain.candidates[0].disposition).toBe('review');
    expect(offDomain.candidates[0].inDomain).toBe(false);
  });

  it('trapWords 命中即永不 suggest', () => {
    const g = entry({ wrong: 'Raymond', correct: 'Raymond' });
    const r = recallCandidates('roadmap 相关', [g], {
      domainTerms: ['Raymond'],
      trapWords: ['roadmap'],
      weakSimilarity: 0.1,
    });
    for (const c of r.candidates) expect(c.disposition).toBe('review');
  });

  it('riskLevel 非 low 时不给 suggest', () => {
    const g = entry({ wrong: 'MeshSeed', correct: 'MeshSeed', riskLevel: 'high' });
    const r = recallCandidates('写成了 meshseed', [g], { domainTerms: ['MeshSeed'] });
    const hit = r.candidates[0];
    expect(hit).toBeDefined();
    expect(hit.disposition).toBe('review');
  });

  it('paused 词条与 action=delete 词条不参与召回', () => {
    const paused = entry({ wrong: 'K-STAR', correct: 'KSTAR', status: 'paused' });
    const filler = entry({ wrong: 'KSTAR', correct: 'KSTAR', action: 'delete', kind: 'filler' });
    const r = recallCandidates('K-STAR', [paused, filler], { domainTerms: ['KSTAR'] });
    expect(r.candidates).toHaveLength(0);
  });
});

describe('四条护栏与精确扫描同语义', () => {
  it('边界：coxy 不得命中 coxyx（更长的 ASCII 词内部）', () => {
    const r = recallCandidates('coxyx 是另一个东西', [cogseed], { domainTerms: ['Cogseed'] });
    expect(r.candidates).toHaveLength(0);
    // 拒绝必须可见（与"截断必须可见"同一原则）：包含关系守卫单独计桶
    expect(r.stats.denied.contains_other_word).toBeGreaterThan(0);
  });

  it('保护区域：URL 与行内 code 不做召回', () => {
    const r = recallCandidates('见 https://x.test/K-STAR 与 `K-STAR` 两处', [kstar], {
      domainTerms: ['KSTAR'],
    });
    expect(r.candidates).toHaveLength(0);
  });

  it('语境加白优先于黑名单：整条静默', () => {
    const g = entry({ wrong: 'mesh seed', correct: 'MeshSeed', contextAllow: ['种子'] });
    const r = recallCandidates('这是种子 mesh seed', [g], { domainTerms: ['MeshSeed'] });
    expect(r.candidates).toHaveLength(0);
    expect(r.stats.denied.context_allowed).toBeGreaterThan(0);
  });

  it('语境黑名单命中即拒', () => {
    const g = entry({ wrong: 'mesh seed', correct: 'MeshSeed', contextDeny: ['植物'] });
    const r = recallCandidates('植物 mesh seed', [g], { domainTerms: ['MeshSeed'] });
    expect(r.candidates).toHaveLength(0);
    expect(r.stats.denied.context_denied).toBeGreaterThan(0);
  });

  it('作用域：global=false 且 docId 不匹配时不召回', () => {
    const scoped = entry({
      wrong: 'K-STAR', correct: 'KSTAR',
      scope: { docIds: ['doc-a'], scenarioTags: [], global: false },
    });
    const miss = recallCandidates('K-STAR', [scoped], { docId: 'doc-b' });
    const hit = recallCandidates('K-STAR', [scoped], { docId: 'doc-a' });
    expect(miss.candidates).toHaveLength(0);
    expect(hit.candidates).toHaveLength(1);
  });

  it('多词条窗口：code seat 这类两 token 形态能成窗', () => {
    const g = entry({ wrong: 'code seat', correct: 'Cogseed' });
    const r = recallCandidates('它写成了 code seat 这样', [g], { domainTerms: ['Cogseed'] });
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0].wrong).toBe('code seat');
  });

  it('跨句读的 token 不成窗（不会把两个句子拼起来匹配）', () => {
    const g = entry({ wrong: 'code seat', correct: 'Cogseed' });
    const r = recallCandidates('写成了 code。seat 是另一个词', [g], {
      domainTerms: ['Cogseed'],
      weakSimilarity: 0.1,
    });
    expect(r.candidates.filter((c) => c.wrong.includes('seat'))).toHaveLength(0);
  });
});

describe('中文音近接入口 extraPhonetic（零依赖下的拼音挂点）', () => {
  const jingwen = entry({ wrong: '静雯', correct: '静雯', kind: 'people' });

  it('不注入拼音时中文音近召回不到（显式记录的已知缺口）', () => {
    const r = recallCandidates('静文说了这句话', [jingwen], { domainTerms: ['静雯'] });
    expect(r.candidates).toHaveLength(0);
  });

  it('注入拼音表后 静文 → 静雯 走 phonetic 通道命中', () => {
    const r = recallCandidates('静文说了这句话', [jingwen], {
      domainTerms: ['静雯'],
      extraPhonetic: { 静: 'jing', 雯: 'wen', 文: 'wen' },
    });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].channel).toBe('phonetic');
    expect(r.candidates[0].similarity).toBe(1);
    expect(r.candidates[0].correct).toBe('静雯');
  });
});

describe('重叠消解与统计', () => {
  it('长 span 优先：K star 与 star 同时可能命中时保留长的', () => {
    const long = entry({ wrong: 'K star', correct: 'KSTAR', kind: 'term' });
    const short = entry({ wrong: 'star', correct: 'STAR', kind: 'term' });
    const r = recallCandidates('K star 的记录', [long, short], { domainTerms: ['KSTAR'] });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].wrong).toBe('K star');
  });

  it('byChannel 分桶计数与实际候选一致', () => {
    const r = recallCandidates('K-STAR 与 cogsed 与 k42', [kstar, cogseedLong, k4], {
      domainTerms: ['KSTAR', 'Cogseed'],
    });
    const total = Object.values(r.stats.byChannel).reduce((a, b) => a + b, 0);
    expect(total).toBe(r.candidates.length);
    expect(r.stats.byChannel.normalized).toBe(1); // K-STAR
    expect(r.stats.byChannel.weak).toBe(1);       // k42
  });

  it('residual 把兜不住的形态报出来，且不含任何词条的 correct 形态', () => {
    const r = recallCandidates('roadmap 和 Cogseed 都在，还有 蓝翔挖掘机', [cogseedLong], {
      domainTerms: ['Cogseed'],
    });
    const surfaces = r.stats.residual.map((x) => x.surface);
    expect(surfaces).toContain('roadmap');
    expect(surfaces).not.toContain('Cogseed');
    for (const x of r.stats.residual) expect(x.count).toBeGreaterThan(0);
  });

  it('maxCandidates 截断必须可见', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      entry({ wrong: `K${i}STAR`, correct: `K${i}STAR`, kind: 'term' }));
    const text = many.map((e) => e.wrong).join(' 和 ');
    const full = recallCandidates(text, many);
    const cut = recallCandidates(text, many, { maxCandidates: 2 });
    expect(full.candidates).toHaveLength(5);
    expect(cut.candidates).toHaveLength(2);
    expect(cut.stats.truncated).toBe(true);
    expect(full.stats.truncated).toBe(false);
  });

  it('纯函数：同一输入两次调用结果一致（无隐藏状态）', () => {
    const a = recallCandidates('K-STAR 与 cogsed', SEED, { domainTerms: DOMAIN });
    const b = recallCandidates('K-STAR 与 cogsed', SEED, { domainTerms: DOMAIN });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
