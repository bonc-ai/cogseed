/** 审计摘要的 Unicode 安全：正文类字段只留字数，无正文前缀可截断。 */
import { seedStoredAbilityAsset } from '../helpers/stored-ability-asset';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'probe-r9-audit-emoji';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r9-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 检测字符串是否含未配对代理（孤立高/低代理码元）。 */
function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      const prev = text.charCodeAt(i - 1);
      if (!(prev >= 0xD800 && prev <= 0xDBFF)) return true;
    }
  }
  return false;
}

async function loadAssets() {
  return import('../../src/main/features/recall/asset-service');
}

const ASSET_ID = 'aa-p9emoji01';

async function seed(statement: string) {
  const assets = await loadAssets();
  const now = new Date().toISOString();
  // 直建存量档：createAbilityAsset 正门要求持久化的夜间候选，本探针只关心
  // 审计摘要，不走晋升链（与 merge/lifecycle 探针同款 seed 口径）。
  await seedStoredAbilityAsset(UID, {
    schemaVersion: 2, ownerId: UID, id: ASSET_ID, candidateId: `cand-${ASSET_ID}`,
    sourceCandidateIds: [`cand-${ASSET_ID}`], reviewDecisionId: 'rd_prober9seed01',
    type: 'personal', title: '资产 r9', statement,
    evidenceRefs: [{ kind: 'conversation', id: `conv-${ASSET_ID}` }], scope: 'general', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
    createdAt: now, updatedAt: now,
  } as never, { actor: 'user', reason: 'probe seed' });
  return assets;
}

describe('审计摘要无正文可截断：emoji 正文的摘要不含孤立代理与正文片段', () => {
  it('正文类字段摘要只留字数：更新前后的 before/after 无孤立代理、无正文片段', async () => {
    const assets = await seed('a'.repeat(59) + '🙂' + '正文尾巴。');
    // 正文本体 round-trip 干净（对照组：孤立代理不是种子自带）
    const seeded = await assets.readAbilityAsset(UID, ASSET_ID);
    expect(hasUnpairedSurrogate(seeded.statement)).toBe(false);

    // 改正文触发 diff 审计：旧/新正文都在代理对边界上构造截断诱因。
    await assets.updateAbilityAsset(UID, ASSET_ID, {
      statement: 'b'.repeat(59) + '🙃' + '新正文尾巴。',
      reason: 'probe emoji split', actor: 'user',
    });

    const audit = await assets.listAbilityAssetAudit(UID, ASSET_ID);
    const updated = audit.find((row) => String(row.action || '') === 'updated');
    expect(updated).toBeTruthy();
    // 直接检测原始字符串——ES2019 起对孤立代理会被转义成 ASCII，
    // 经 JSON.stringify 就检不到了；上屏读的是原始码元，检测须对齐。
    const summaryText = String(updated!.before ?? '') + String(updated!.after ?? '');
    // 正文类字段摘要=「N 字」，没有正文前缀可截断——孤立代理无从产生。
    expect(hasUnpairedSurrogate(summaryText)).toBe(false);
    expect(summaryText).not.toContain('🙂');
    expect(summaryText).not.toContain('🙃');
    expect(summaryText).toMatch(/statement=\d+ 字/);
    // 对照：资产正文本体（不截断路径）仍干净。
    const after = await assets.readAbilityAsset(UID, ASSET_ID);
    expect(hasUnpairedSurrogate(after.statement)).toBe(false);
  });

  it('summarizeAuditValue/summarizeAuditChange：正文只出字数，整行不再触发截断', async () => {
    const { summarizeAuditChange, summarizeAuditValue } = await import('../../src/main/features/recall/asset-service');
    // 60 前缀单点（与主用例同款边界构造）：值不进摘要，只有长度。
    const value = summarizeAuditValue('statement', 'c'.repeat(59) + '🙂' + '尾');
    expect(String(value)).toBe('62 字'); // 59 + 代理对 2 码元 + 1
    expect(hasUnpairedSurrogate(String(value))).toBe(false);
    // 240 整行单点：六段 scope 摘要各自只有字数，join 后远低于 240，无 … 截断。
    const changes = Array.from({ length: 6 }, (_, i) => {
      const payload = i < 5 ? `v${i}-` + 'm'.repeat(33) : 'm'.repeat(18) + '🙂';
      return { field: 'scope', before: payload, after: payload };
    });
    const summary = summarizeAuditChange(changes as never);
    expect(summary).toBeTruthy();
    const joined = String(summary!.before);
    expect(joined).not.toContain('…');
    expect(hasUnpairedSurrogate(joined)).toBe(false);
    expect((joined.match(/scope=/g) || []).length).toBe(6);
  });
});
