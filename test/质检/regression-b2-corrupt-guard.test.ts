/** 本体、候选池和词表坏档的结构化错误、拒写、备份及恢复入口。 */
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

// paths.ts 的 WS_ROOT 在模块加载时定格：每个用例换 tmpDir 前必须 resetModules，
// 用例内动态导入（与 test/质检/probe-r1-po-badjson-overwrite 同款模式）。
let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-reg-guard-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});
afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function poDoc(uid: string): string {
  return path.join(tmpDir, uid, 'cloud', 'cognition', 'personal-ontology.json');
}

async function loadPoStore() {
  return import('../../src/main/features/po/store');
}

async function loadGuard() {
  return import('../../src/main/util/corrupt-guard');
}

function corruptBackupsOf(file: string): string[] {
  return fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(`${path.basename(file)}.corrupt-`));
}

describe('po 同构点：坏 JSON → 备份 + 拒写 + 恢复入口', () => {
  it('坏 JSON → copy 备份（原文件不动）→ editPoDoc 拒写，盘上字节保留', async () => {
    const uid = 'reg_po_bad';
    const store = await loadPoStore();
    // seed：先写一份真实文档（无坏档时写路径正常）。
    const seeded = await store.editPoDoc(uid, () => {});
    expect(seeded.ok).toBe(true);
    expect(fs.existsSync(poDoc(uid))).toBe(true);

    // 模拟云同步截断。
    const corruptBytes = '{"schemaVersion":2,"groups":[{"id":"g1","ti';
    fs.writeFileSync(poDoc(uid), corruptBytes);

    // 读侧探测：loadPoDocSync 返回空文档（展示用），坏档已登记 + 备份在场。
    const doc = store.loadPoDocSync(uid);
    expect(doc.groups).toEqual([]);
    expect(corruptBackupsOf(poDoc(uid))).toHaveLength(1);
    expect(fs.readFileSync(poDoc(uid), 'utf8')).toBe(corruptBytes); // copy 不动原文件

    // 写侧拒绝：整条统一写路径返回结构化失败，不落盘。
    const refused = await store.editPoDoc(uid, () => {});
    expect(refused.ok).toBe(false);
    expect(String(refused.error)).toContain('corrupt');
    expect(fs.readFileSync(poDoc(uid), 'utf8')).toBe(corruptBytes); // 未被空文档+新增覆盖
    expect(corruptBackupsOf(poDoc(uid))).toHaveLength(1); // 重复读不堆同内容备份
  });

  it('restore：最新备份 copy 回原位；内容仍坏则下次读取重新登记（不新增备份）', async () => {
    const uid = 'reg_po_restore';
    const store = await loadPoStore();
    const guard = await loadGuard();
    const seeded = await store.editPoDoc(uid, () => {});
    expect(seeded.ok).toBe(true);
    const corruptBytes = '{"schemaVersion":2,"groups":[{"id":"g1","ti';
    fs.writeFileSync(poDoc(uid), corruptBytes);
    store.loadPoDocSync(uid); // 触发登记 + 备份
    const [backupName] = corruptBackupsOf(poDoc(uid));
    expect(backupName).toBeTruthy();

    const res = guard.restoreCorruptFile(poDoc(uid));
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(poDoc(uid), 'utf8')).toBe(corruptBytes);

    // 恢复的字节仍解析失败 → 下次读取重新登记，且内容相同不重复备份。
    store.loadPoDocSync(uid);
    expect(guard.corruptRecordFor(poDoc(uid))).toBeTruthy();
    expect(corruptBackupsOf(poDoc(uid))).toHaveLength(1);
  });

  it('reset：删除坏档原文件（备份保留）→ 真 ENOENT 空初始化 → 可写恢复', async () => {
    const uid = 'reg_po_reset';
    const store = await loadPoStore();
    const guard = await loadGuard();
    const seeded = await store.editPoDoc(uid, () => {});
    expect(seeded.ok).toBe(true);
    fs.writeFileSync(poDoc(uid), '{"schemaVersion":2,"groups":[{"id":"g1","ti');
    store.loadPoDocSync(uid);
    expect(corruptBackupsOf(poDoc(uid))).toHaveLength(1);

    expect(guard.resetCorruptFile(poDoc(uid)).ok).toBe(true);
    expect(fs.existsSync(poDoc(uid))).toBe(false); // 真 ENOENT
    expect(corruptBackupsOf(poDoc(uid))).toHaveLength(1); // 备份保留

    // 空初始化合法（不误伤），写路径恢复。
    const after = await store.editPoDoc(uid, () => {});
    expect(after.ok).toBe(true);
    expect(fs.existsSync(poDoc(uid))).toBe(true);
  });

  it('自愈：坏档被外部修复（读得回合法 JSON）后，拒写解除', async () => {
    const uid = 'reg_po_heal';
    const store = await loadPoStore();
    const guard = await loadGuard();
    const seeded = await store.editPoDoc(uid, () => {});
    expect(seeded.ok).toBe(true);
    fs.writeFileSync(poDoc(uid), '{"schemaVersion":2,"groups":[{"id":"g1","ti');
    store.loadPoDocSync(uid);
    expect(guard.corruptRecordFor(poDoc(uid))).toBeTruthy();

    // 外部修复（云同步还原 / 用户手修）。
    fs.writeFileSync(poDoc(uid), JSON.stringify({ schemaVersion: 2, groups: [], trash: [] }));
    store.loadPoDocSync(uid);
    expect(guard.corruptRecordFor(poDoc(uid))).toBeUndefined();
    const healed = await store.editPoDoc(uid, () => {});
    expect(healed.ok).toBe(true);
  });
});

describe('候选池：读错只吞真 ENOENT，其余备份+拒写+如实上报', () => {
  it('读错（非 ENOENT）→ listCandidates 带回 corrupt + addCandidate 拒写 + 盘上不动', async () => {
    const uid = 'reg_cand_io';
    const cands = await import('../../src/main/features/personal_ontology_candidates');
    const md = cands.candidatesMdPath(uid);
    await cands.addCandidate(uid, { candidate_id: 'c_keep_1', summary: '池里的存量候选' });
    expect(fs.existsSync(md)).toBe(true);
    const bytesBefore = fs.readFileSync(md, 'utf8');

    // 模拟磁盘故障（非 ENOENT 的读错）。旧病：readTextSafe 吞掉 → 空表 →
    // 下一次写（含后台回流投放）全量覆写 = 候选池静默清空。
    //
    // 注入方式必须跨平台：Windows 的 chmod 只映射文件的只读属性
    // （`0o000` 仍可读），造不出「文件还在但读失败」。把池文件换成同名目录，
    // readFileSync 在三个平台上都以非 ENOENT（EISDIR 或 EACCES）失败，正是
    // readTextGuarded 判为坏档的那条分支（code !== 'ENOENT'）；恢复时把原
    // 字节写回同一路径。
    fs.rmSync(md, { force: true });
    fs.mkdirSync(md);

    const data = await cands.listCandidates(uid);
    expect(data.corrupt).toBeTruthy(); // 读侧结构化错误（失败≠空态）
    await expect(cands.addCandidate(uid, { summary: '读错期间的新候选' }))
      .rejects.toMatchObject({ code: 'cognition_file_corrupt' });

    // 外部修复（目录换回原文件）→ 读成功自愈 → 可写。
    fs.rmdirSync(md);
    fs.writeFileSync(md, bytesBefore);
    const healed = await cands.listCandidates(uid);
    expect(healed.corrupt).toBeUndefined();
    expect(healed.candidate_updates.map((c) => c.candidate_id)).toContain('c_keep_1');
    expect(fs.readFileSync(md, 'utf8')).toBe(bytesBefore); // 全程未被覆盖
    await cands.addCandidate(uid, { candidate_id: 'c_after_heal', summary: '自愈后的新候选' });
    const final = await cands.listCandidates(uid);
    expect(final.candidate_updates.map((c) => c.candidate_id)).toEqual(
      expect.arrayContaining(['c_keep_1', 'c_after_heal']),
    );
  });

  it('真 ENOENT（新用户空池）不受影响，正常入池（对照组）', async () => {
    const uid = 'reg_cand_fresh';
    const cands = await import('../../src/main/features/personal_ontology_candidates');
    const data = await cands.listCandidates(uid);
    expect(data.candidate_updates).toEqual([]);
    expect(data.corrupt).toBeUndefined();
    await cands.addCandidate(uid, { candidate_id: 'c_fresh_1', summary: '第一条' });
    const after = await cands.listCandidates(uid);
    expect(after.candidate_updates).toHaveLength(1);
  });
});

describe('词表重置出路：reset 后空初始化可写，备份保留', () => {
  // 词表坏档契约：读侧降级空表保兼容，坏档登记 + copy 备份 +
  // 写侧拒写（CorruptFileError code=cognition_file_corrupt），盘上字节不被
  // 「空表+新条目」覆盖；reset 后真 ENOENT 空初始化，写能力恢复。
  it('词表坏 JSON：读侧空表兼容 + 写侧拒写 + 备份在场；reset 后可重新写入', async () => {
    const uid = 'reg_glos_reset';
    const glossary = await import('../../src/main/features/transcript_glossary');
    const { userTranscriptGlossaryFile } = await import('../../src/main/paths');
    const guard = await loadGuard();
    const file = userTranscriptGlossaryFile(uid);
    glossary.upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed' });
    const corruptBytes = '{"version":2,"uid":"' + uid + '","entries":[{"wrong":"cox';
    fs.writeFileSync(file, corruptBytes);
    // 读侧：兼容降级为空表（不抛错——面板/扫描读路径不受坏档影响）。
    expect(glossary.loadGlossary(uid).entries).toEqual([]);
    // 写侧：最普通的写路径抛结构化坏档错误，坏档已 copy 备份。
    let writeErr: Error | undefined;
    try { glossary.upsertEntry(uid, { wrong: 'moodle', correct: 'Moodle' }); } catch (err) { writeErr = err as Error; }
    expect(writeErr).toBeTruthy();
    expect((writeErr as { code?: string }).code).toBe('cognition_file_corrupt');
    expect(corruptBackupsOf(file)).toHaveLength(1);
    // 盘上仍是坏档原字节（未被清成空表+新条目）。
    expect(fs.readFileSync(file, 'utf8')).toBe(corruptBytes);

    expect(guard.resetCorruptFile(file).ok).toBe(true);
    expect(corruptBackupsOf(file)).toHaveLength(1); // 备份保留（外部抢救线索）
    // 真 ENOENT → 空初始化 → 可写。
    expect(glossary.loadGlossary(uid).entries).toEqual([]);
    glossary.upsertEntry(uid, { wrong: 'moodle', correct: 'Moodle' });
    expect(glossary.loadGlossary(uid).entries.map((e) => e.wrong)).toEqual(['moodle']);
  });
});
