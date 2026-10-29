import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Group destinations write through personal_ontology_groups.ts, which triggers
// kb_indexer/search side effects (mirrors contexts.ts's write path). Mocked
// here the same way contexts.test.ts does, so loading these modules doesn't
// pull in fastembed/sqlite-vec.
vi.mock('../../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'test-user-001';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-poc-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadModule() {
  return import('../../../src/main/features/personal_ontology_candidates');
}

async function loadMemory() {
  return import('../../../src/main/features/memory');
}

async function loadGroups() {
  return import('../../../src/main/features/personal_ontology_groups');
}

async function loadTemplateMod() {
  return import('../../../src/main/features/personal_ontology_template_files');
}

function candidatesMdPath(): string {
  return path.join(tmpDir, UID, 'local', 'ontology_candidates', 'candidates.md');
}

function legacyJsonPath(): string {
  return path.join(tmpDir, UID, 'local', 'ontology_candidates', 'candidates.json');
}

function userProfilePath(): string {
  return path.join(tmpDir, UID, 'cloud', 'memory', 'USER.md');
}

/** 模板记忆独立文件（2026-09-22 搬迁后 role_template 条目的落点）。 */
function roleTemplateMemoryPath(templateId = 'student'): string {
  return path.join(tmpDir, UID, 'cloud', 'memory', 'role-templates', `${templateId}.md`);
}

function sharedMemoryPath(): string {
  return path.join(tmpDir, UID, 'cloud', 'memory', 'MEMORY.md');
}

// ── parse/serialize round-trip ──────────────────────────────────────────

describe('personal_ontology_candidates › markdown parse/serialize', () => {
  it('round-trips a candidate through serialize → parse', async () => {
    const poc = await loadModule();
    const candidates = [{
      candidate_id: 'cand-001',
      kind: 'preference' as const,
      confidence: 'high' as const,
      summary: '喜欢直接说人话，不要堆术语',
      memory_scope: 'user' as const,
      memory_text: '沟通风格：喜欢直接、口语化的解释',
      source_memory_refs: ['conv-abc-turn-1', 'conv-abc-turn-5'],
    }];
    const md = poc.serializeCandidatesMarkdown(candidates);
    const parsed = poc.parseCandidatesMarkdown(md);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].candidate_id).toBe('cand-001');
    expect(parsed[0].kind).toBe('preference');
    expect(parsed[0].confidence).toBe('high');
    expect(parsed[0].memory_scope).toBe('user');
    expect(parsed[0].memory_text).toBe('沟通风格：喜欢直接、口语化的解释');
    expect(parsed[0].source_memory_refs).toEqual(['conv-abc-turn-1', 'conv-abc-turn-5']);
  });

  it('returns empty array for empty markdown', async () => {
    const poc = await loadModule();
    expect(poc.parseCandidatesMarkdown('')).toEqual([]);
    expect(poc.parseCandidatesMarkdown('# 个人本体候选（待确认）\n\n暂无待确认候选。\n')).toEqual([]);
  });
});

// ── listCandidates ───────────────────────────────────────────────────────

describe('personal_ontology_candidates › listCandidates', () => {
  it('returns empty arrays when no files exist', async () => {
    const poc = await loadModule();
    const data = await poc.listCandidates(UID);
    expect(data.candidate_updates).toEqual([]);
    expect(data.blocked_items).toEqual([]);
  });

  it('reads candidates written directly to candidates.md', async () => {
    const poc = await loadModule();
    const file = candidatesMdPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, poc.serializeCandidatesMarkdown([{
      candidate_id: 'cand-x',
      kind: 'rule',
      confidence: 'medium',
      summary: '摘要文本',
      memory_scope: 'shared',
      memory_text: '记忆文本',
      source_memory_refs: [],
    }]));
    const data = await poc.listCandidates(UID);
    expect(data.candidate_updates).toHaveLength(1);
    expect(data.candidate_updates[0].candidate_id).toBe('cand-x');
  });
});

// ── rejectCandidate ────────────────────────────────────────────────────

describe('personal_ontology_candidates › rejectCandidate', () => {
  it('removes the candidate without writing any memory', async () => {
    const poc = await loadModule();
    const file = candidatesMdPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, poc.serializeCandidatesMarkdown([{
      candidate_id: 'cand-rej-1',
      kind: 'instance',
      confidence: 'low',
      summary: 'x',
      memory_scope: 'user',
      memory_text: 'x',
      source_memory_refs: [],
    }]));

    const res = await poc.rejectCandidate(UID, 'cand-rej-1', 'not accurate');
    expect(res.ok).toBe(true);

    const after = await poc.listCandidates(UID);
    expect(after.candidate_updates).toHaveLength(0);
    expect(fs.existsSync(userProfilePath())).toBe(false);
    expect(fs.existsSync(sharedMemoryPath())).toBe(false);
  });
});

// ── batch operations ─────────────────────────────────────────────────────

describe('personal_ontology_candidates › batch reject', () => {
  it('rejectCandidates removes only the targeted ids', async () => {
    const poc = await loadModule();
    const file = candidatesMdPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, poc.serializeCandidatesMarkdown([
      { candidate_id: 'c1', kind: 'instance', confidence: 'low', summary: 'a', memory_scope: 'user', memory_text: 'a', source_memory_refs: [] },
      { candidate_id: 'c2', kind: 'instance', confidence: 'low', summary: 'b', memory_scope: 'user', memory_text: 'b', source_memory_refs: [] },
    ]));

    const res = await poc.rejectCandidates(UID, ['c1']);
    expect(res.rejectedCount).toBe(1);

    const after = await poc.listCandidates(UID);
    expect(after.candidate_updates).toHaveLength(1);
    expect(after.candidate_updates[0].candidate_id).toBe('c2');
  });

});

// ── 阶段 B：建议字段（target_field）路由 ───────────────────────────────────

describe('personal_ontology_candidates › candidates.md 建议字段行', () => {
  it('round-trips the optional 建议字段 line (serialize → parse)', async () => {
    const poc = await loadModule();
    const candidates = [{
      candidate_id: 'cand-field-1',
      kind: 'preference' as const,
      confidence: 'high' as const,
      summary: '喜欢大白话',
      memory_scope: 'user' as const,
      memory_text: '沟通风格：喜欢大白话',
      target_field: '偏好',
      source_memory_refs: ['conv-1'],
    }];
    const md = poc.serializeCandidatesMarkdown(candidates);
    expect(md).toContain('- 建议字段: 偏好');
    // 建议字段行在来源行之前
    const prefIdx = md.indexOf('- 建议字段: 偏好');
    const srcIdx = md.indexOf('- 来源: conv-1');
    expect(prefIdx).toBeGreaterThan(-1);
    expect(srcIdx).toBeGreaterThan(prefIdx);

    const parsed = poc.parseCandidatesMarkdown(md);
    expect(parsed[0].target_field).toBe('偏好');
  });

  it('old format without 建议字段 line parses with target_field undefined', async () => {
    const poc = await loadModule();
    const md = '### cand-old\n- 类型: preference\n- 置信度: high\n- 摘要: x\n- 记忆去向: user\n- 来源: conv-1\n';
    const parsed = poc.parseCandidatesMarkdown(md);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].target_field).toBeUndefined();
  });
});

// ── M3：治理元数据字段（sensitivity / write_actor / recorded_time）─────────────

describe('personal_ontology_candidates › M3 governance metadata round-trip', () => {
  it('round-trips all three new fields through serialize → parse', async () => {
    const poc = await loadModule();
    const candidates = [{
      candidate_id: 'cand-m3-1',
      kind: 'preference' as const,
      confidence: 'high' as const,
      summary: '喜欢大白话',
      memory_scope: 'user' as const,
      memory_text: '沟通风格：喜欢直接说人话',
      source_memory_refs: ['conv-1'],
      sensitivity: 'restricted' as const,
      write_actor: 'user' as const,
      recorded_time: '2026-08-09T10:30:00.000Z',
    }];
    const md = poc.serializeCandidatesMarkdown(candidates);
    // 非默认值才会序列化
    expect(md).toContain('- 敏感度: restricted');
    expect(md).toContain('- 写入者: user');
    expect(md).toContain('- 记录时间: 2026-08-09T10:30:00.000Z');

    const parsed = poc.parseCandidatesMarkdown(md);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].sensitivity).toBe('restricted');
    expect(parsed[0].write_actor).toBe('user');
    expect(parsed[0].recorded_time).toBe('2026-08-09T10:30:00.000Z');
  });

  it('omits sensitivity/write_actor when they are default values (standard/llm)', async () => {
    const poc = await loadModule();
    const candidates = [{
      candidate_id: 'cand-m3-2',
      kind: 'preference' as const,
      confidence: 'medium' as const,
      summary: '摘要',
      memory_scope: 'user' as const,
      memory_text: '文本',
      source_memory_refs: [],
      sensitivity: 'standard' as const,
      write_actor: 'llm' as const,
    }];
    const md = poc.serializeCandidatesMarkdown(candidates);
    // 默认值不入 markdown（保持文件清爽）
    expect(md).not.toContain('敏感度');
    expect(md).not.toContain('写入者');

    const parsed = poc.parseCandidatesMarkdown(md);
    expect(parsed[0].sensitivity).toBe('standard');
    expect(parsed[0].write_actor).toBe('llm');
  });

  it('old format without M3 fields parses with safe defaults', async () => {
    const poc = await loadModule();
    // 模拟 M2 版本的 candidates.md（无敏感度/写入者/记录时间行）
    const oldMd = '### cand-old\n- 类型: preference\n- 置信度: high\n- 摘要: 旧候选\n- 记忆去向: user\n- 记忆文本: 旧文本\n- 来源: conv-1\n';
    const parsed = poc.parseCandidatesMarkdown(oldMd);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].sensitivity).toBe('standard');
    expect(parsed[0].write_actor).toBe('llm');
    expect(parsed[0].recorded_time).toBe('');
  });

  it('coerces invalid sensitivity/write_actor values to safe defaults', async () => {
    const poc = await loadModule();
    const badMd = '### cand-bad\n- 类型: preference\n- 置信度: high\n- 摘要: x\n- 记忆去向: user\n- 敏感度: top-secret\n- 写入者: hacker\n- 记录时间: not-a-date\n- 来源: conv-1\n';
    const parsed = poc.parseCandidatesMarkdown(badMd);
    expect(parsed[0].sensitivity).toBe('standard'); // 非法值 → standard
    expect(parsed[0].write_actor).toBe('llm');       // 非法值 → llm
    expect(parsed[0].recorded_time).toBe('not-a-date'); // 字符串照收（parser 不校验 ISO）
  });

  it('sensitivity=standard and write_actor=llm re-serialize without those lines (no noise)', async () => {
    const poc = await loadModule();
    // parse → serialize 往返：默认值不产生额外行
    const oldMd = '### cand-clean\n- 类型: preference\n- 置信度: high\n- 摘要: x\n- 记忆去向: user\n- 来源: conv-1\n';
    const parsed = poc.parseCandidatesMarkdown(oldMd);
    const reSerialized = poc.serializeCandidatesMarkdown(parsed);
    expect(reSerialized).not.toContain('敏感度');
    expect(reSerialized).not.toContain('写入者');
    expect(reSerialized).not.toContain('记录时间');
  });
});

// ── 二期 D5：确认链路来源项目标记（dest.projectId → @proj:<pid>）───────────

describe('personal_ontology_candidates › project source marker via confirm', () => {
  /** 写候选池（独立 tmpDir，id 可复用）。 */
  async function seedCandidates(poc: Awaited<ReturnType<typeof loadModule>>, items: Array<{ id: string; text: string }>) {
    const file = candidatesMdPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, poc.serializeCandidatesMarkdown(items.map((it) => ({
      candidate_id: it.id,
      kind: 'preference',
      confidence: 'high',
      summary: 's',
      memory_scope: 'user',
      memory_text: it.text,
      source_memory_refs: [],
    }))));
  }

  it('candidate pool format round-trips a `来源项目` line (D5 进池标记地基)', async () => {
    const poc = await loadModule();
    const cands = [{
      candidate_id: 'cand-pj-1',
      kind: 'preference' as const,
      confidence: 'high' as const,
      summary: '摘要',
      memory_scope: 'user' as const,
      memory_text: '记忆文本',
      source_memory_refs: [] as string[],
      project_id: 'p_from_pool',
    }];
    const text = poc.serializeCandidatesMarkdown(cands);
    expect(text).toContain('- 来源项目: p_from_pool');
    const parsed = poc.parseCandidatesMarkdown(text);
    expect(parsed[0].project_id).toBe('p_from_pool');
  });
});

/* ═══════════ 写入前冲突门（specs/014 US-902 / T015）═══════════
 * embedding 受控替身：默认**不可用**（走降级放行 + 日志，既有用例不受门影响）；
 * 冲突用例显式开启。「北京/上海」在谈同一件事（高相似），「旅行」无关。 */
const GATE_VECTORS: Record<string, [number, number]> = {
  常住北京: [1, 0],
  常住上海: [0.99, 0.02],
  每年旅行一次: [0, 1],
};
let gateEmbeddingAvailable = false;
vi.mock('../../../src/main/features/recall/similarity', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/main/features/recall/similarity')>();
  return {
    ...original,
    embedForDedup: async (_uid: string, text: string): Promise<number[] | null> => {
      if (!gateEmbeddingAvailable) return null;
      return GATE_VECTORS[text] ?? null;
    },
  };
});
