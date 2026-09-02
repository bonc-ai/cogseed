/**
 * 本地压测数据生成/清理脚本（演示用，只动自己创建的数据）。
 *
 * 用法（先退出 CogSeed 应用再跑）：
 *   npx tsx scripts/perf-seed-local.ts seed   [--spaces 40 --convs 20 --files 100]
 *   npx tsx scripts/perf-seed-local.ts clean
 *
 * seed 模式：在真实用户数据里创建 N 个「压测-」前缀空间、每空间 M 个会话
 *   （带聊天记录 + members.json）、每个空间 K 个文件。创建清单记录在
 *   <数据根>/perf-seed-manifest.json。
 * clean 模式：按清单删除创建的空间/会话/文件，并清掉工作空间元数据表
 *   （该表是纯派生缓存，删除后应用会自动重建）。
 */

/* eslint-disable no-console */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

function dataRoot(): string {
  return (
    process.env.COGSEED_WORKSPACE_ROOT
    || path.join(os.homedir(), '.cogseed', 'runtime-variants', 'cogseed', 'data')
  );
}

function activeUid(): string {
  const usersFile = path.join(dataRoot(), 'users.json');
  try {
    const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    // 应用会按 { current_user_id, users: [{ user_id }] } 重写该文件
    if (typeof users.current_user_id === 'string' && users.current_user_id) return users.current_user_id;
    if (Array.isArray(users.users) && users.users[0]?.user_id) return users.users[0].user_id;
    if (Array.isArray(users) && users[0]?.id) return users[0].id;
    if (typeof users === 'object' && users.active) return users.active;
    if (typeof users === 'object') {
      const keys = Object.keys(users).filter((k) => /^\d+$/.test(k) || users[k]?.id);
      if (keys[0]) return typeof users[keys[0]] === 'object' ? users[keys[0]].id : keys[0];
    }
  } catch { /* fallthrough */ }
  throw new Error('无法从 users.json 识别用户 id；请用 COGSEED_WORKSPACE_ROOT 指向数据根后重试');
}

function parseArgs(argv: string[]): { mode: string; spaces: number; convs: number; files: number } {
  const mode = argv[0] || 'seed';
  const out = { mode, spaces: 40, convs: 20, files: 100 };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--spaces') out.spaces = Number(argv[++i]);
    else if (argv[i] === '--convs') out.convs = Number(argv[++i]);
    else if (argv[i] === '--files') out.files = Number(argv[++i]);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  process.env.COGSEED_WORKSPACE_ROOT = dataRoot();
  const uid = activeUid();

  const users = await import('../src/main/features/users');
  users.activateUser(uid);
  const spaces = await import('../src/main/features/spaces');
  const chats = await import('../src/main/features/chats');
  const pathsMod = await import('../src/main/paths');

  const manifestFile = path.join(dataRoot(), 'perf-seed-manifest.json');

  if (args.mode === 'clean') {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { spaceIds: string[]; dirs: string[]; files: string[] };
    for (const sid of manifest.spaceIds) {
      try { await spaces.deleteSpace(uid, sid); } catch { /* best-effort */ }
    }
    for (const f of manifest.files) { try { fs.rmSync(f, { force: true }); } catch { /* best-effort */ } }
    for (const d of manifest.dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
    // 元数据表是派生缓存，直接丢弃让应用重建
    try { fs.rmSync(pathsMod.workspaceMetaDir(uid), { recursive: true, force: true }); } catch { /* best-effort */ }
    try { fs.rmSync(manifestFile, { force: true }); } catch { /* best-effort */ }
    console.log('[perf-seed] 已清理压测数据 + 元数据表');
    return;
  }

  const spaceIds: string[] = [];
  const dirs: string[] = [];
  const files: string[] = [];

  console.log(`[perf-seed] 开始创建：${args.spaces} 空间 × ${args.convs} 会话 × ${args.files} 文件 …`);
  for (let s = 0; s < args.spaces; s += 1) {
    const created = await spaces.createSpace(uid, { name: `压测-${s}` });
    if (!created.ok) throw new Error(`create space failed: ${String(created.error)}`);
    const sid = created.space.space_id;
    spaceIds.push(sid);

    for (let c = 0; c < args.convs; c += 1) {
      const conv = await chats.createConversation(uid, { title: `压测任务-${s}-${c}`, spaceId: sid });
      const cid = conv.conversation_id;
      const membersDir = path.join(pathsMod.userChatsDir(uid), cid);
      fs.mkdirSync(membersDir, { recursive: true });
      dirs.push(membersDir);
      fs.writeFileSync(path.join(membersDir, 'members.json'), JSON.stringify({
        version: 1,
        commander_spoken: true,
        actors: [
          { kind: 'commander', id: 'commander', name: 'Commander', joined_at: '2026-01-01T00:00:00.000Z' },
          { kind: 'agent', id: 'agent-a', name: 'A', joined_at: '2026-01-01T00:00:00.000Z' },
          { kind: 'agent', id: 'agent-b', name: 'B', joined_at: '2026-01-01T00:00:00.000Z' },
        ],
      }));
      const jsonl = path.join(pathsMod.userChatsDir(uid), `${cid}.jsonl`);
      const lines: string[] = [];
      for (let k = 0; k < 200; k += 1) {
        lines.push(JSON.stringify({
          from: k % 2 === 0 ? 'commander' : 'user',
          to: k % 2 === 0 ? 'user' : 'commander',
          ts: `2026-01-01T00:${String(k % 60).padStart(2, '0')}.000Z`,
          text: `压测消息 ${s}-${c}-${k}，用于模拟长聊天记录体积。`,
        }));
      }
      fs.writeFileSync(jsonl, `${lines.join('\n')}\n`);
      files.push(jsonl);
    }

    const filesRoot = pathsMod.spaceFilesDir(uid, sid);
    fs.mkdirSync(filesRoot, { recursive: true });
    dirs.push(filesRoot);
    for (let f = 0; f < args.files; f += 1) {
      const p = path.join(filesRoot, `压测文件-${f}.md`);
      fs.writeFileSync(p, `# ${s}-${f}`);
      files.push(p);
    }
  }

  fs.writeFileSync(manifestFile, JSON.stringify({ spaceIds, dirs, files }, null, 2));
  console.log(`[perf-seed] 完成：${spaceIds.length} 空间、${spaceIds.length * args.convs} 会话、${spaceIds.length * args.files} 文件`);
  console.log('[perf-seed] 现在打开 CogSeed → 进入「工作空间」，观察日志：');
  console.log('  tail -f ~/.cogseed/runtime-variants/cogseed/data/logs/$(date +%Y-%m-%d).log | grep -E "listSpaces|listSpaceConversations|listSpaceArtifacts|listSpaceFileTree"');
}

main().catch((err) => {
  console.error(`[perf-seed] 失败: ${(err as Error)?.message || String(err)}`);
  process.exitCode = 1;
});
