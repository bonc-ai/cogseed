import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * `migrate-project-layout-v5` 是 v5 数据路径的地基（`cloud/projects/<pid>/…` →
 * `cloud/spaces/<sid>/…`，会话行补 `space_id`），此前完全没有测试覆盖
 * （2026-10-08 迁移审计 P0）。这里锁住它的外部契约：
 *   - 只读统计与搬移一致（排除墓碑）
 *   - 搬移落点：空间索引 / 空间 chats / 空间 sessions / 空间产物 / 全局附件
 *   - 幂等（marker）、force 重跑、活动锁不抢、非法 uid 不抛
 *   - 孤儿项目（无 space_id）不动
 *   - 多项目同空间：按 cid 合并、incoming 覆盖
 */

let tmpDir: string;
let prevWs: string | undefined;

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function writeText(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, 'utf8');
}

function convRow(cid: string, pid: string, extra: Record<string, unknown> = {}) {
  return {
    conversation_id: cid,
    title: `chat ${cid}`,
    kind: 'normal',
    agent_id: '',
    skill_id: '',
    session_id: `gconv-${cid}`,
    project_id: pid,
    created_at: '2026-07-01T00:00:00',
    updated_at: '2026-07-01T00:01:00',
    ...extra,
  };
}

const UID = 'u1';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-project-layout-v5-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function load() {
  const p = await import('../../../src/main/paths');
  const m = await import('../../../src/main/util/migrate-project-layout-v5');
  return { p, ...m };
}

const markerPath = (p: any) => path.join(p.userLocalRoot(UID), 'migrations', 'project-layout-v5.json');
const lockPath = (p: any) => path.join(p.userLocalRoot(UID), 'migrations', 'project-layout-v5.lock');

describe('collectProjectSpaceStats', () => {
  it('counts conversations per project, excludes tombstones, and writes nothing', async () => {
    const { p, collectProjectSpaceStats } = await load();
    writeJson(p.projectMetaFile(UID, 'p_space'), { project_id: 'p_space', name: 'Has space', space_id: 's1' });
    writeJson(p.projectChatIndexFile(UID, 'p_space'), [
      convRow('c1', 'p_space'),
      convRow('c2', 'p_space'),
      convRow('c3', 'p_space', { deleted_at: '2026-07-02T00:00:00' }),
    ]);
    writeJson(p.projectMetaFile(UID, 'p_orphan'), { project_id: 'p_orphan', name: 'No space' });
    writeJson(p.projectChatIndexFile(UID, 'p_orphan'), [convRow('c4', 'p_orphan')]);

    const stats = collectProjectSpaceStats(UID);

    expect(stats.projects_total).toBe(2);
    expect(stats.projects_with_space).toBe(1);
    expect(stats.projects_orphan).toBe(1);
    expect(stats.conversations_total).toBe(3); // c3 is a tombstone
    expect(stats.conversations_with_space).toBe(2);
    expect(stats.conversations_orphan).toBe(1);
    expect(stats.by_project).toEqual([
      { project_id: 'p_orphan', space_id: null, name: 'No space', conversations: 1 },
      { project_id: 'p_space', space_id: 's1', name: 'Has space', conversations: 2 },
    ]);
    expect(stats.warnings).toEqual([]);
    // 只读：不建空间目录、不写 marker
    expect(fs.existsSync(p.spaceChatsDir(UID, 's1'))).toBe(false);
    expect(fs.existsSync(markerPath(p))).toBe(false);
  });
});

describe('migrateProjectLayoutV5', () => {
  it('moves a space-bound project into the space layout and keeps project_id beside space_id', async () => {
    const { p, migrateProjectLayoutV5, MIGRATION_VERSION } = await load();
    writeJson(p.projectMetaFile(UID, 'p1'), { project_id: 'p1', name: 'P1', space_id: 's1' });
    writeJson(p.projectChatIndexFile(UID, 'p1'), [convRow('c1', 'p1')]);
    writeText(path.join(p.projectChatsDir(UID, 'p1'), 'c1.jsonl'), '{"from":"user","text":"hi"}\n');
    writeText(path.join(p.projectSessionsDir(UID, 'p1'), 'gconv-c1.jsonl'), '{"role":"user","content":"hi"}\n');
    writeText(path.join(p.projectChatAttachmentsDir(UID, 'p1'), 'c1', 'note.txt'), 'attachment');
    writeText(path.join(p.projectChatArtifactsDir(UID, 'p1'), 'c1', 'index.html'), '<html></html>');
    writeJson(path.join(p.projectChatsDir(UID, 'p1'), 'c1', 'state.json'), { status: 'idle' });

    const stats = migrateProjectLayoutV5(UID);

    expect(stats.warnings).toEqual([]);
    expect(stats.projects_migrated).toBe(1);
    expect(stats.conversations_moved).toBe(1);
    expect(stats.sessions_moved).toBeGreaterThan(0);
    expect(stats.attachments_moved).toBeGreaterThan(0);
    expect(stats.artifacts_moved).toBeGreaterThan(0);

    // 索引：进空间索引，space_id 与 project_id 双字段并存
    const spaceIndex = JSON.parse(fs.readFileSync(p.spaceChatIndexFile(UID, 's1'), 'utf8'));
    expect(spaceIndex).toHaveLength(1);
    expect(spaceIndex[0]).toMatchObject({ conversation_id: 'c1', space_id: 's1', project_id: 'p1' });

    // 内容落点
    expect(fs.existsSync(path.join(p.spaceChatsDir(UID, 's1'), 'c1.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(p.spaceChatsDir(UID, 's1'), 'c1', 'state.json'))).toBe(true);
    expect(fs.existsSync(path.join(p.spaceSessionsDir(UID, 's1'), 'gconv-c1.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(p.spaceChatArtifactsDir(UID, 's1'), 'c1', 'index.html'))).toBe(true);
    // 附件按全局 cid 目录落（不进空间）
    expect(fs.existsSync(path.join(p.chatAttachmentDir(UID, 'c1'), 'note.txt'))).toBe(true);
    // 源索引被清掉，源 chats 目录不再持有内容
    expect(fs.existsSync(p.projectChatIndexFile(UID, 'p1'))).toBe(false);
    expect(fs.existsSync(path.join(p.projectChatsDir(UID, 'p1'), 'c1.jsonl'))).toBe(false);

    // marker + 锁清理
    const marker = JSON.parse(fs.readFileSync(markerPath(p), 'utf8'));
    expect(marker.version).toBe(MIGRATION_VERSION);
    expect(fs.existsSync(lockPath(p))).toBe(false);
  });

  it('is idempotent: the marker short-circuits a second run', async () => {
    const { p, migrateProjectLayoutV5 } = await load();
    writeJson(p.projectMetaFile(UID, 'p1'), { project_id: 'p1', name: 'P1', space_id: 's1' });
    writeJson(p.projectChatIndexFile(UID, 'p1'), [convRow('c1', 'p1')]);
    writeText(path.join(p.projectChatsDir(UID, 'p1'), 'c1.jsonl'), '{"from":"user","text":"hi"}\n');

    const first = migrateProjectLayoutV5(UID);
    expect(first.projects_migrated).toBe(1);
    const movedAt = fs.readFileSync(path.join(p.spaceChatsDir(UID, 's1'), 'c1.jsonl'), 'utf8');

    const second = migrateProjectLayoutV5(UID);
    expect(second).toEqual({
      projects_migrated: 0,
      conversations_moved: 0,
      sessions_moved: 0,
      attachments_moved: 0,
      artifacts_moved: 0,
      warnings: [],
    });
    expect(fs.readFileSync(path.join(p.spaceChatsDir(UID, 's1'), 'c1.jsonl'), 'utf8')).toBe(movedAt);
  });

  it('re-runs when forced, merging late rows instead of duplicating them', async () => {
    const { p, migrateProjectLayoutV5 } = await load();
    writeJson(p.projectMetaFile(UID, 'p1'), { project_id: 'p1', name: 'P1', space_id: 's1' });
    writeJson(p.projectChatIndexFile(UID, 'p1'), [convRow('c1', 'p1')]);
    writeText(path.join(p.projectChatsDir(UID, 'p1'), 'c1.jsonl'), '{"from":"user","text":"hi"}\n');
    migrateProjectLayoutV5(UID);

    // 迟到的同步数据回到项目侧：force 应把它并进空间索引，而不是产生重复行
    writeJson(p.projectChatIndexFile(UID, 'p1'), [convRow('c1', 'p1'), convRow('c2', 'p1')]);
    writeText(path.join(p.projectChatsDir(UID, 'p1'), 'c2.jsonl'), '{"from":"user","text":"late"}\n');

    const forced = migrateProjectLayoutV5(UID, { force: true });
    expect(forced.warnings).toEqual([]);
    expect(forced.conversations_moved).toBe(2);

    const spaceIndex = JSON.parse(fs.readFileSync(p.spaceChatIndexFile(UID, 's1'), 'utf8'));
    expect(spaceIndex.map((r: any) => r.conversation_id).sort()).toEqual(['c1', 'c2']);
    expect(spaceIndex.every((r: any) => r.space_id === 's1')).toBe(true);
    expect(fs.existsSync(path.join(p.spaceChatsDir(UID, 's1'), 'c2.jsonl'))).toBe(true);
  });

  it('leaves orphan projects (no space_id) untouched for the later phase', async () => {
    const { p, migrateProjectLayoutV5 } = await load();
    writeJson(p.projectMetaFile(UID, 'p_orphan'), { project_id: 'p_orphan', name: 'Orphan' });
    writeJson(p.projectChatIndexFile(UID, 'p_orphan'), [convRow('c9', 'p_orphan')]);
    writeText(path.join(p.projectChatsDir(UID, 'p_orphan'), 'c9.jsonl'), '{"from":"user","text":"orphan"}\n');

    const stats = migrateProjectLayoutV5(UID);

    expect(stats.projects_migrated).toBe(0);
    expect(stats.conversations_moved).toBe(0);
    expect(stats.warnings).toEqual([]);
    expect(fs.existsSync(p.projectChatIndexFile(UID, 'p_orphan'))).toBe(true);
    expect(fs.existsSync(path.join(p.projectChatsDir(UID, 'p_orphan'), 'c9.jsonl'))).toBe(true);
    // marker 仍会写：阶段 0 已完成，孤儿留给阶段 4
    expect(JSON.parse(fs.readFileSync(markerPath(p), 'utf8')).version).toBe(5);
  });

  it('merges two projects that point at the same space, incoming row winning per cid', async () => {
    const { p, migrateProjectLayoutV5 } = await load();
    writeJson(p.projectMetaFile(UID, 'pA'), { project_id: 'pA', name: 'A', space_id: 'sShared' });
    writeJson(p.projectChatIndexFile(UID, 'pA'), [
      convRow('cSame', 'pA', { title: 'from A' }),
      convRow('cA', 'pA'),
    ]);
    writeText(path.join(p.projectChatsDir(UID, 'pA'), 'cA.jsonl'), '{"from":"user","text":"A"}\n');
    writeJson(p.projectMetaFile(UID, 'pB'), { project_id: 'pB', name: 'B', space_id: 'sShared' });
    writeJson(p.projectChatIndexFile(UID, 'pB'), [
      convRow('cSame', 'pB', { title: 'from B' }),
      convRow('cB', 'pB'),
    ]);
    writeText(path.join(p.projectChatsDir(UID, 'pB'), 'cB.jsonl'), '{"from":"user","text":"B"}\n');

    const stats = migrateProjectLayoutV5(UID);

    expect(stats.warnings).toEqual([]);
    expect(stats.projects_migrated).toBe(2);
    const spaceIndex = JSON.parse(fs.readFileSync(p.spaceChatIndexFile(UID, 'sShared'), 'utf8'));
    expect(spaceIndex.map((r: any) => r.conversation_id).sort()).toEqual(['cA', 'cB', 'cSame']);
    // 同 cid 后到者覆盖（项目按 id 升序处理，B 在 A 之后）
    expect(spaceIndex.find((r: any) => r.conversation_id === 'cSame')).toMatchObject({
      title: 'from B', space_id: 'sShared', project_id: 'pB',
    });
    expect(fs.existsSync(path.join(p.spaceChatsDir(UID, 'sShared'), 'cA.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(p.spaceChatsDir(UID, 'sShared'), 'cB.jsonl'))).toBe(true);
  });

  it('does not steal a lock held by a live process', async () => {
    const { p, migrateProjectLayoutV5 } = await load();
    writeJson(p.projectMetaFile(UID, 'p1'), { project_id: 'p1', name: 'P1', space_id: 's1' });
    writeJson(p.projectChatIndexFile(UID, 'p1'), [convRow('c1', 'p1')]);
    writeText(path.join(p.projectChatsDir(UID, 'p1'), 'c1.jsonl'), '{"from":"user","text":"hi"}\n');
    writeJson(lockPath(p), { pid: process.pid, started_at_ms: Date.now() });

    const stats = migrateProjectLayoutV5(UID);

    expect(stats.projects_migrated).toBe(0);
    expect(stats.conversations_moved).toBe(0);
    // 别人的锁既没被抢，也没被删；内容原地不动，marker 不写
    expect(fs.existsSync(lockPath(p))).toBe(true);
    expect(fs.existsSync(path.join(p.projectChatsDir(UID, 'p1'), 'c1.jsonl'))).toBe(true);
    expect(fs.existsSync(markerPath(p))).toBe(false);
  });

  it('steals a stale lock whose owner is gone', async () => {
    const { p, migrateProjectLayoutV5 } = await load();
    writeJson(p.projectMetaFile(UID, 'p1'), { project_id: 'p1', name: 'P1', space_id: 's1' });
    writeJson(p.projectChatIndexFile(UID, 'p1'), [convRow('c1', 'p1')]);
    writeText(path.join(p.projectChatsDir(UID, 'p1'), 'c1.jsonl'), '{"from":"user","text":"hi"}\n');
    writeJson(lockPath(p), { pid: 999_999_999, started_at_ms: Date.now() - 60 * 60 * 1000 });

    const stats = migrateProjectLayoutV5(UID);

    expect(stats.projects_migrated).toBe(1);
    expect(fs.existsSync(path.join(p.spaceChatsDir(UID, 's1'), 'c1.jsonl'))).toBe(true);
    expect(fs.existsSync(lockPath(p))).toBe(false);
  });

  it('isolates a failing project: the others still migrate and the failure is a warning', async () => {
    const { p, migrateProjectLayoutV5 } = await load();
    // pBad：把 `cloud/spaces` 本身占成文件 → 建 `cloud/spaces/<sid>` 时 ENOTDIR，该项目必然失败
    writeJson(p.projectMetaFile(UID, 'pBad'), { project_id: 'pBad', name: 'Bad', space_id: 'sBad' });
    writeJson(p.projectChatIndexFile(UID, 'pBad'), [convRow('cBad', 'pBad')]);
    const spacesRoot = path.dirname(path.dirname(p.spaceChatIndexFile(UID, 'sBad')));
    writeText(spacesRoot, 'not a directory'); // 占位
    // pGood：正常项目
    writeJson(p.projectMetaFile(UID, 'pGood'), { project_id: 'pGood', name: 'Good', space_id: 'sGood' });
    writeJson(p.projectChatIndexFile(UID, 'pGood'), [convRow('cGood', 'pGood')]);
    writeText(path.join(p.projectChatsDir(UID, 'pGood'), 'cGood.jsonl'), '{"from":"user","text":"ok"}\n');

    const stats = migrateProjectLayoutV5(UID);

    expect(stats.warnings).toHaveLength(1);
    expect(stats.warnings[0]).toContain('pBad');
    expect(stats.projects_migrated).toBe(1); // 只有 pGood
    expect(fs.existsSync(path.join(p.spaceChatsDir(UID, 'sGood'), 'cGood.jsonl'))).toBe(true);
    expect(fs.existsSync(p.projectChatIndexFile(UID, 'pBad'))).toBe(true); // 失败项目原地保留
  });

  it('records the failed project and retries only it on the next launch', async () => {
    const { p, migrateProjectLayoutV5 } = await load();
    // 把公共的 `cloud/spaces` 占成文件 → 建 `cloud/spaces/<sid>/chats` 时父路径是文件 → ENOTDIR，
    // 两个项目都会失败（注意 spaceChatIndexFile 在 `<space>/chats/_index.json`，所以是三层 dirname）
    writeJson(p.projectMetaFile(UID, 'pBad'), { project_id: 'pBad', name: 'Bad', space_id: 'sBad' });
    writeJson(p.projectChatIndexFile(UID, 'pBad'), [convRow('cBad', 'pBad')]);
    writeText(path.join(p.projectChatsDir(UID, 'pBad'), 'cBad.jsonl'), '{"from":"user","text":"bad"}\n');
    writeJson(p.projectMetaFile(UID, 'pGood'), { project_id: 'pGood', name: 'Good', space_id: 'sGood' });
    writeJson(p.projectChatIndexFile(UID, 'pGood'), [convRow('cGood', 'pGood')]);
    writeText(path.join(p.projectChatsDir(UID, 'pGood'), 'cGood.jsonl'), '{"from":"user","text":"ok"}\n');
    const spacesRoot = path.dirname(path.dirname(path.dirname(p.spaceChatIndexFile(UID, 'sBad'))));
    writeText(spacesRoot, 'not a directory');

    const first = migrateProjectLayoutV5(UID);
    expect(first.warnings, JSON.stringify(first.warnings)).toHaveLength(2);
    // marker 记下失败项（而不是把一次瞬时失败当成永久完成）
    const marker = JSON.parse(fs.readFileSync(markerPath(p), 'utf8'));
    expect(marker.version).toBe(5);
    expect([...marker.failed_project_ids].sort()).toEqual(['pBad', 'pGood']);

    // 清掉占位文件后**无需 force**：下次启动自动补做失败的项目
    fs.rmSync(spacesRoot, { force: true });
    const retry = migrateProjectLayoutV5(UID);
    expect(retry.warnings).toEqual([]);
    expect(retry.projects_migrated).toBe(2);
    expect(fs.existsSync(path.join(p.spaceChatsDir(UID, 'sBad'), 'cBad.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(p.spaceChatsDir(UID, 'sGood'), 'cGood.jsonl'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(markerPath(p), 'utf8')).failed_project_ids).toEqual([]);
  });

  it('retries only the failed project, leaving already-migrated ones alone', async () => {
    const { p, migrateProjectLayoutV5 } = await load();
    // 先让 pGood 正常迁移（无失败项）
    writeJson(p.projectMetaFile(UID, 'pGood'), { project_id: 'pGood', name: 'Good', space_id: 'sGood' });
    writeJson(p.projectChatIndexFile(UID, 'pGood'), [convRow('cGood', 'pGood')]);
    writeText(path.join(p.projectChatsDir(UID, 'pGood'), 'cGood.jsonl'), '{"from":"user","text":"ok"}\n');
    const first = migrateProjectLayoutV5(UID);
    expect(first.warnings).toEqual([]);
    expect(JSON.parse(fs.readFileSync(markerPath(p), 'utf8')).failed_project_ids).toEqual([]);
    const migratedBytes = fs.readFileSync(path.join(p.spaceChatsDir(UID, 'sGood'), 'cGood.jsonl'), 'utf8');

    // 之后加入一个会失败的项目：force 全量跑一次以制造失败项
    writeJson(p.projectMetaFile(UID, 'pBad'), { project_id: 'pBad', name: 'Bad', space_id: 'sBad' });
    writeJson(p.projectChatIndexFile(UID, 'pBad'), [convRow('cBad', 'pBad')]);
    writeText(path.join(p.projectChatsDir(UID, 'pBad'), 'cBad.jsonl'), '{"from":"user","text":"bad"}\n');
    const spacesRoot = path.dirname(path.dirname(p.spaceChatIndexFile(UID, 'sBad')));
    writeText(spacesRoot, 'not a directory');
    const second = migrateProjectLayoutV5(UID, { force: true });
    expect(second.warnings).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(markerPath(p), 'utf8')).failed_project_ids).toEqual(['pBad']);

    // 修复后普通启动：只补做 pBad，已迁移的 pGood 内容字节不变
    fs.rmSync(spacesRoot, { force: true });
    const third = migrateProjectLayoutV5(UID);
    expect(third.warnings).toEqual([]);
    expect(third.projects_migrated).toBe(1);
    expect(fs.readFileSync(path.join(p.spaceChatsDir(UID, 'sGood'), 'cGood.jsonl'), 'utf8')).toBe(migratedBytes);
  });

  it('reports an invalid uid as a warning instead of throwing', async () => {
    const { migrateProjectLayoutV5 } = await load();
    const stats = migrateProjectLayoutV5('../evil');
    expect(stats.projects_migrated).toBe(0);
    expect(stats.warnings).toEqual(['invalid uid: ../evil']);
  });
});
