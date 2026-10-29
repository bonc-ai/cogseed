/**
 * 贡献包导入的数据契约：kind 按白名单归一，wrong/correct 超限时跳过整条。
 * parseContributionPack 与普通词表导入都须在写盘前限制字段，保证写入与读回一致。
 * 用非法枚举与超长合成词条检查两条入口，不依赖真实用户数据。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseContributionPack,
  applyContributionPack,
  CONTRIBUTION_PACK_FORMAT,
  type ContributionPack,
} from '../../src/main/features/transcript_contribution_pack';
import { loadGlossary, importGlossary } from '../../src/main/features/transcript_glossary';
import { userTranscriptGlossaryFile } from '../../src/main/paths';

let tmpDir: string;
let uid = '';
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-pack-r1-'));
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  uid = `u_pack_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function packWith(entries: Array<Record<string, unknown>>): ContributionPack {
  return {
    format: CONTRIBUTION_PACK_FORMAT,
    exportedAt: Date.now(),
    ownerScope: 'org',
    counts: { total: entries.length, peopleExcluded: 0, byKind: {} },
    entries: entries as never[],
  };
}

describe('贡献包导入：kind 白名单与长度上限', () => {
  it('对照组：importGlossary 通道（upsertEntry）对超长词条拒绝/跳过', async () => {
    const long = 'X'.repeat(5000); // > MAX_WRONG_LEN=80
    const res = importGlossary(uid, { entries: [{ wrong: long, correct: 'Y' }] });
    expect(res.imported).toBe(0);
    expect(res.skipped).toBe(1);
    expect(loadGlossary(uid).entries.length).toBe(0);
  });

  it('parseContributionPack 把非法 kind 归一成 term → 落盘 kind 合法，写读一致', async () => {
    const pack = parseContributionPack(packWith([
      { wrong: 'coxy', correct: 'Cogseed', kind: 'hyperdimensional', riskLevel: 'low' },
    ]));
    expect(pack).not.toBeNull();
    // kind 走与读侧 normalizeKind 同款白名单，不再原样透传。
    expect(pack!.entries[0].kind).toBe('term');

    const result = applyContributionPack(uid, pack!);
    expect(result.added).toBe(1);

    // 盘上 JSON 不再带非法 kind——写读对称，读回不再静默变形。
    expect(fs.readFileSync(userTranscriptGlossaryFile(uid), 'utf8')).not.toContain('"kind": "hyperdimensional"');

    const reloaded = loadGlossary(uid);
    expect(reloaded.entries[0].kind).toBe('term');
  });

  it('wrong>80 在 parse 层整条跳过，不再绕过上限落盘（bounded 只在 upsertEntry）', async () => {
    const long = 'Z'.repeat(5000);
    const pack = parseContributionPack(packWith([
      { wrong: long, correct: 'Y', kind: 'term', riskLevel: 'low' },
    ]));
    expect(pack!.entries.length).toBe(0); // parse 层长度门：超长整条剔除

    const result = applyContributionPack(uid, pack!);
    expect(result.added).toBe(0);
    expect(loadGlossary(uid).entries.length).toBe(0); // 超限词条不落盘
  });
});
