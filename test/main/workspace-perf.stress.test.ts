/**
 * 工作空间大数据压测（opt-in）。
 *
 * 常规 CI 不跑（describe.skipIf 门控）；手动跑出数字：
 *   COGSEED_PERF_STRESS=1 node scripts/run-tests.mjs run test/main/workspace-perf.stress.test.ts
 *
 * 场景：30 个空间 + 1 个大空间（40 个会话、200 个空间文件、30 个附件），
 * 度量冷/热两次调用的耗时——验证「变更才扫」缓存与轻量化路径在大数据
 * 形态下的数字（热路径应远低于冷路径）。只打印数字并做宽松断言，
 * 不设硬性性能红线。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-perf-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function msOf(start: [number, number]): number {
  const diff = process.hrtime(start);
  return Math.round(diff[0] * 1000 + diff[1] / 1e6);
}

function now(): [number, number] {
  return process.hrtime();
}

describe.skipIf(!process.env.COGSEED_PERF_STRESS)('workspace 大数据压测', () => {
  it('冷/热两次调用对比（打印数字）', async () => {
    const spaces = await import('../../../src/main/features/spaces');
    const chats = await import('../../../src/main/features/chats');
    const projectFiles = await import('../../../src/main/features/project_files');
    const artifacts = await import('../../../src/main/features/spaces_artifacts');
    const pathsMod = await import('../../../src/main/paths');

    // ── 种子：30 个普通空间 + 1 个大空间（40 会话 / 200 文件 / 30 附件）──
    for (let i = 0; i < 30; i += 1) {
      await spaces.createSpace(TEST_UID, { name: `普通空间${i}` });
    }
    const big = await spaces.createSpace(TEST_UID, { name: '大空间' });
    if (!big.ok) throw new Error('big space create failed');
    const sid = big.space.space_id;

    for (let i = 0; i < 40; i += 1) {
      const conv = await chats.createConversation(TEST_UID, { title: `任务${i}`, spaceId: sid });
      const cid = conv.conversation_id;
      // members.json：commander + 2 agents，已标记发言
      const membersDir = path.join(pathsMod.userChatsDir(TEST_UID), cid);
      fs.mkdirSync(membersDir, { recursive: true });
      fs.writeFileSync(path.join(membersDir, 'members.json'), JSON.stringify({
        version: 1,
        commander_spoken: true,
        actors: [
          { kind: 'commander', id: 'commander', name: 'Commander', joined_at: '2026-01-01T00:00:00.000Z' },
          { kind: 'agent', id: 'agent-a', name: 'A', joined_at: '2026-01-01T00:00:00.000Z' },
          { kind: 'agent', id: 'agent-b', name: 'B', joined_at: '2026-01-01T00:00:00.000Z' },
        ],
      }));
      // 50 行聊天记录（约 4KB）
      const lines: string[] = [];
      for (let k = 0; k < 50; k += 1) {
        lines.push(JSON.stringify({
          from: k % 2 === 0 ? 'commander' : 'user',
          to: k % 2 === 0 ? 'user' : 'commander',
          ts: `2026-01-01T00:00:${String(k % 60).padStart(2, '0')}.000Z`,
          text: `第 ${i} 会话第 ${k} 条消息，用于压测聊天记录体积。`,
        }));
      }
      fs.writeFileSync(path.join(pathsMod.userChatsDir(TEST_UID), `${cid}.jsonl`), `${lines.join('\n')}\n`);
      // 附件：前 30 个会话各放 1 个
      if (i < 30) {
        const attDir = path.join(tmpDir, TEST_UID, 'cloud', 'chat_attachments', cid);
        fs.mkdirSync(attDir, { recursive: true });
        fs.writeFileSync(path.join(attDir, `资料${i}.pdf`), 'x');
      }
    }

    // 空间文件：200 个文件分布在 20 个子目录
    const filesRoot = pathsMod.spaceFilesDir(TEST_UID, sid);
    for (let d = 0; d < 20; d += 1) {
      const dir = path.join(filesRoot, `dir-${d}`);
      fs.mkdirSync(dir, { recursive: true });
      for (let f = 0; f < 10; f += 1) {
        fs.writeFileSync(path.join(dir, `file-${f}.md`), `# ${d}-${f}`);
      }
    }
    // 共享工作区：40 个会话共享同一工作区根（产物兜底遍历的真实形态）
    const wsRoot = pathsMod.spaceWorkspaceDir(TEST_UID, sid);
    for (let d = 0; d < 20; d += 1) {
      const dir = path.join(wsRoot, `out-${d}`);
      fs.mkdirSync(dir, { recursive: true });
      for (let f = 0; f < 10; f += 1) {
        fs.writeFileSync(path.join(dir, `产出-${f}.md`), `# ${d}-${f}`);
      }
    }

    // ── 度量 ──
    const results: Record<string, { cold: number; warm: number }> = {};

    let t = now();
    await spaces.listSpaces(TEST_UID);
    results['spaces.list'] = { cold: msOf(t), warm: 0 };
    t = now();
    await spaces.listSpaces(TEST_UID);
    results['spaces.list'].warm = msOf(t);

    t = now();
    await chats.listSpaceConversations(TEST_UID, sid);
    results['listSpaceConversations(40会话)'] = { cold: msOf(t), warm: 0 };
    t = now();
    await chats.listSpaceConversations(TEST_UID, sid);
    results['listSpaceConversations(40会话)'].warm = msOf(t);

    t = now();
    await artifacts.listSpaceArtifacts(TEST_UID, sid);
    results['listSpaceArtifacts(40会话)'] = { cold: msOf(t), warm: 0 };
    t = now();
    await artifacts.listSpaceArtifacts(TEST_UID, sid);
    results['listSpaceArtifacts(40会话)'].warm = msOf(t);

    t = now();
    await projectFiles.listSpaceFileTree(TEST_UID, sid);
    results['listSpaceFileTree(200文件)'] = { cold: msOf(t), warm: 0 };
    t = now();
    await projectFiles.listSpaceFileTree(TEST_UID, sid);
    results['listSpaceFileTree(200文件)'].warm = msOf(t);

    // eslint-disable-next-line no-console
    console.log('\n[perf-stress] 冷/热对比（ms）:');
    for (const [name, r] of Object.entries(results)) {
      // eslint-disable-next-line no-console
      console.log(`  ${name.padEnd(34)} cold=${String(r.cold).padStart(5)} warm=${String(r.warm).padStart(5)}  (${r.warm < r.cold ? '↓' : '='} 热路径${r.warm <= r.cold ? '不慢于' : '慢于'}冷路径)`);
      // 宽松断言：热路径不得慢于冷路径（缓存生效的底线）
      expect(r.warm).toBeLessThanOrEqual(r.cold + 20);
    }
  }, 300_000);
});

describe.skipIf(!process.env.COGSEED_PERF_STRESS)('workspace 元数据表 · 重启后冷启动', () => {
  it('表命中路径：重启（模块重载）后首次调用直接查表', async () => {
    const users = await import('../../../src/main/features/users');
    users.activateUser(TEST_UID);
    const spaces = await import('../../../src/main/features/spaces');
    const chats = await import('../../../src/main/features/chats');
    const artifacts = await import('../../../src/main/features/spaces_artifacts');
    const projectFiles = await import('../../../src/main/features/project_files');
    const meta = await import('../../../src/main/features/workspace_meta');
    const pathsMod = await import('../../../src/main/paths');

    // 种子：10 空间 + 1 大空间（20 会话）
    for (let i = 0; i < 10; i += 1) {
      await spaces.createSpace(TEST_UID, { name: `表空间${i}` });
    }
    const big = await spaces.createSpace(TEST_UID, { name: '表大空间' });
    if (!big.ok) throw new Error('create failed');
    const sid = big.space.space_id;
    for (let i = 0; i < 20; i += 1) {
      const conv = await chats.createConversation(TEST_UID, { title: `表任务${i}`, spaceId: sid });
      const membersDir = path.join(pathsMod.userChatsDir(TEST_UID), conv.conversation_id);
      fs.mkdirSync(membersDir, { recursive: true });
      fs.writeFileSync(path.join(membersDir, 'members.json'), JSON.stringify({
        version: 1, commander_spoken: true,
        actors: [{ kind: 'commander', id: 'commander', joined_at: 'x' }, { kind: 'agent', id: 'a', joined_at: 'x' }],
      }));
      fs.writeFileSync(path.join(pathsMod.userChatsDir(TEST_UID), `${conv.conversation_id}.jsonl`), '{"from":"commander"}\n');
    }
    const filesRoot = pathsMod.spaceFilesDir(TEST_UID, sid);
    fs.mkdirSync(filesRoot, { recursive: true });
    for (let f = 0; f < 50; f += 1) fs.writeFileSync(path.join(filesRoot, `f${f}.md`), '# x');

    // 首轮：实时计算并写表
    await spaces.listSpaces(TEST_UID);
    await chats.listSpaceConversations(TEST_UID, sid);
    await artifacts.listSpaceArtifacts(TEST_UID, sid);
    await projectFiles.listSpaceFileTree(TEST_UID, sid);
    await meta.flush(TEST_UID);

    // 模拟进程重启：清空整个模块注册表（内存缓存/内存表全部消失），
    // 只留磁盘上的 meta.json
    vi.resetModules();
    const users2 = await import('../../../src/main/features/users');
    users2.activateUser(TEST_UID);
    const spaces2 = await import('../../../src/main/features/spaces');
    const chats2 = await import('../../../src/main/features/chats');
    const artifacts2 = await import('../../../src/main/features/spaces_artifacts');
    const projectFiles2 = await import('../../../src/main/features/project_files');

    const results: Record<string, number> = {};
    let t = now();
    await spaces2.listSpaces(TEST_UID);
    results['spaces.list（重启后首次）'] = msOf(t);
    t = now();
    await chats2.listSpaceConversations(TEST_UID, sid);
    results['listSpaceConversations（重启后首次）'] = msOf(t);
    t = now();
    await artifacts2.listSpaceArtifacts(TEST_UID, sid);
    results['listSpaceArtifacts（重启后首次）'] = msOf(t);
    t = now();
    await projectFiles2.listSpaceFileTree(TEST_UID, sid);
    results['listSpaceFileTree（重启后首次）'] = msOf(t);

    // eslint-disable-next-line no-console
    console.log('\n[perf-stress] 重启后冷启动（表命中，ms）:');
    for (const [name, ms] of Object.entries(results)) {
      // eslint-disable-next-line no-console
      console.log(`  ${name.padEnd(34)} ${String(ms).padStart(5)}`);
    }
    // 宽松断言：表命中路径应显著快于实时扫描（< 100ms 量级）
    expect(results['spaces.list（重启后首次）']).toBeLessThan(200);
    expect(results['listSpaceConversations（重启后首次）']).toBeLessThan(200);
  }, 300_000);
});
