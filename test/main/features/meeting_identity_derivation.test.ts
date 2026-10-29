/**
 * 产物文件名 → 会议归集标识的归一化测试（用**真实文件名**，非编造样本）。
 *
 * 为什么这个规则必须测：v001/v002/v003 是同一场会的三份纪要。若归一化不稳，
 * 每存一版就新建一个归集目录，知识库会碎成一堆单文件目录 —— 而这是**不可逆**的
 * （规格 FR-011 不允许迁移已入库文件）。所以归属规则必须钉死。
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

async function loadMod() {
  return import('../../../src/main/features/meeting_kb_precipitate');
}

const DIR = '/Users/x/.cogseed/runtime-variants/cogseed/userWorkSpace/今天上午和中扬哥开的那场会议';

describe('deriveArtifactIdentity', () => {
  it('collapses v001/v002/v003 of the same meeting into ONE meeting key', async () => {
    const { deriveArtifactIdentity } = await loadMod();
    const keys = ['v001', 'v002', 'v003'].map((v) =>
      deriveArtifactIdentity(`${DIR}/2026-10-14_中扬的个人会议室_在线会议_会议纪要_${v}.md`),
    );
    // 三份纪要必须归一 → 否则每版新建目录，库会碎
    expect(new Set(keys.map((k) => k.meetingKey)).size).toBe(1);
    expect(keys.every((k) => k.kind === 'minutes')).toBe(true);
    // 版本各自保留 → 三份能共存、互不覆盖（FR-005）
    expect(keys.map((k) => k.version)).toEqual(['v001', 'v002', 'v003']);
  });

  it('keeps different meetings apart', async () => {
    const { deriveArtifactIdentity } = await loadMod();
    const a = deriveArtifactIdentity(`${DIR}/2026-10-14_中扬的个人会议室_在线会议_会议纪要_v001.md`);
    const b = deriveArtifactIdentity(`${DIR}/2026-09-24_开源产品-阶段性汇报_腾讯会议_会议纪要_v001.md`);
    expect(a.meetingKey).not.toBe(b.meetingKey);
  });

  it('treats a transcript and its minutes as the same meeting, different kinds', async () => {
    const { deriveArtifactIdentity } = await loadMod();
    const minutes = deriveArtifactIdentity(`${DIR}/2026-10-14_中扬的个人会议室_在线会议_会议纪要_v001.md`);
    const transcript = deriveArtifactIdentity(`${DIR}/2026-10-14_中扬的个人会议室_在线会议_转写_v001.md`);
    // 同一场会（归集到一处），但类别不同 → 各自成文件
    expect(minutes.kind).toBe('minutes');
    expect(transcript.kind).toBe('transcript');
  });

  it('recognises the other artifact kinds', async () => {
    const { deriveArtifactIdentity } = await loadMod();
    expect(deriveArtifactIdentity('/w/a_会议_转写-纠错_v002.md').kind).toBe('corrected_transcript');
    expect(deriveArtifactIdentity('/w/a_会议_待办_v001.md').kind).toBe('actions');
  });

  it('does not mistake a mid-name keyword for the artifact kind', async () => {
    const { deriveArtifactIdentity } = await loadMod();
    // "会议纪要" 出现在中段（模板名），不应被当成类别而把后面的名字吃掉
    const r = deriveArtifactIdentity('/w/会议纪要模板_产品评审_v001.md');
    expect(r.kind).toBe('minutes'); // 兜底类别
    expect(r.meetingKey).toContain('产品评审');
  });

  /**
   * 三段式命名（2026-10-15 会上定的规范）：
   *   <日期>_<会议名>_<本场唯一标识>_<类型>[_vNNN].md
   *
   * 第三段是**归集键**：它决定知识库里的目录名。四份产物前缀必须完全一致，
   * 否则同一场会被拆进不同目录 —— 而 FR-011 不允许迁移已入库文件，拆开就不可逆。
   * 下面用规范里给出的四份真实文件名当样本。
   */
  describe('三段式命名（日期_会议名_本场唯一标识_类型）', () => {
    const PREFIX = '2026-10-15_中扬的个人会议室_218658328';

    it('四份产物归到同一个目录，类型段全部识别正确', async () => {
      const { deriveArtifactIdentity } = await loadMod();
      const cases: Array<[string, string]> = [
        [`${PREFIX}_转写.md`, 'transcript'],
        [`${PREFIX}_转写-纠错.md`, 'corrected_transcript'],
        [`${PREFIX}_会议纪要_v001.md`, 'minutes'],
        [`${PREFIX}_任务清单_v001.md`, 'actions'],
      ];
      const keys = new Set<string>();
      for (const [name, kind] of cases) {
        const r = deriveArtifactIdentity(`${DIR}/${name}`);
        expect(r.kind, name).toBe(kind);
        keys.add(r.meetingKey);
      }
      // 四份 → 恰好一个归集目录
      expect(keys.size).toBe(1);
      expect([...keys][0]).toBe('2026-10-15-中扬的个人会议室-218658328');
    });

    it('同一场会的多版纪要不因版本号拆目录', async () => {
      const { deriveArtifactIdentity } = await loadMod();
      const v1 = deriveArtifactIdentity(`${DIR}/${PREFIX}_会议纪要_v001.md`);
      const v2 = deriveArtifactIdentity(`${DIR}/${PREFIX}_会议纪要_v002.md`);
      expect(v1.meetingKey).toBe(v2.meetingKey);
      expect(v1.version).toBe('v001');
      expect(v2.version).toBe('v002');
    });

    it('唯一标识段不会被当成类型段（否则第三段会被目录名吃掉）', async () => {
      const { deriveArtifactIdentity } = await loadMod();
      const r = deriveArtifactIdentity(`${DIR}/${PREFIX}_会议纪要_v001.md`);
      // 会议号必须留在归集键里：agent 靠它回查平台原始记录
      expect(r.meetingKey).toContain('218658328');
    });

    it('旧写法（非类型词落在第三段）会把目录切碎——三段式正是为修它', async () => {
      const { deriveArtifactIdentity } = await loadMod();
      // 历史事故样本：这些目录名现在真实存在于知识库里，且无法迁移
      const legacy = [
        `${DIR}/2026-10-14_中扬的个人会议室_转写正文-原始.md`,
        `${DIR}/2026-10-14_中扬的个人会议室_候选任务清单_v001.md`,
        `${DIR}/会议纪要-中扬的个人会议室-2026-10-14.md`,
      ].map((p) => deriveArtifactIdentity(p));
      // 三份本应同属一场会，旧写法下归集键两两不同 → 目录碎片
      const keys = new Set(legacy.map((r) => r.meetingKey));
      expect(keys.size).toBe(3);
      // 而且认不出类型段时会一律兜底成会议纪要（会污染归集）
      expect(legacy[0].kind).toBe('minutes');
    });
  });

  it('produces a path-safe key for names with slashes, spaces and quotes', async () => {
    const { deriveArtifactIdentity } = await loadMod();
    const r = deriveArtifactIdentity('/w/2026-01-01_A/B "c":d_会议纪要_v001.md');
    expect(r.meetingKey).not.toMatch(/[/\\\\:"'<>|?*]/);
    expect(r.meetingKey.length).toBeGreaterThan(0);
  });

  it('never returns an empty meeting key (falls back safely)', async () => {
    const { deriveArtifactIdentity } = await loadMod();
    for (const p of ['/w/_.md', '/w/v001.md', '/w/会议纪要.md', '/w/.md']) {
      const r = deriveArtifactIdentity(p);
      expect(r.meetingKey.length).toBeGreaterThan(0);
      expect(r.kind).toBeTruthy();
    }
  });

  it('is deterministic (same input → same key, across calls)', async () => {
    const { deriveArtifactIdentity } = await loadMod();
    const p = `${DIR}/2026-10-14_中扬的个人会议室_在线会议_会议纪要_v002.md`;
    expect(deriveArtifactIdentity(p)).toEqual(deriveArtifactIdentity(p));
  });
});
