#!/usr/bin/env node
/**
 * 手动验收用的清场（dev only）：只清两个客户端的 A2A 会话与接待记录，
 * 保留账号、联系人、consent —— 这样下一条提问就会重新变成「首次来访」。
 *
 * 用法：node scripts/dev/a2a-reset.mjs
 * 之后需要重启两个客户端（或直接用 scripts/dev/a2a-dev-start.sh）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 按 variant 扫描 uid 目录，避免把 uid 写死在脚本里（换账号也不用改）。
function rootsForVariant(variant) {
  const dataDir = path.join(os.homedir(), '.cogseed/runtime-variants', variant, 'data');
  let entries = [];
  try { entries = fs.readdirSync(dataDir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dataDir, entry.name))
    .filter((root) => fs.existsSync(path.join(root, 'cloud', 'chats', '_index.json')));
}

const UIDS = [
  ...rootsForVariant('cogseed'),
  ...rootsForVariant('messaging'),
];

for (const root of UIDS) {
  const chats = path.join(root, 'cloud', 'chats');
  const index = path.join(chats, '_index.json');
  if (!fs.existsSync(index)) continue;
  const rows = JSON.parse(fs.readFileSync(index, 'utf8'));
  const keep = rows.filter((row) => !String(row.conversation_id || '').startsWith('a2a-'));
  let removed = 0;
  for (const row of rows) {
    const cid = String(row.conversation_id || '');
    if (!cid.startsWith('a2a-')) continue;
    removed += 1;
    for (const target of [path.join(chats, `${cid}.jsonl`), path.join(chats, cid)]) {
      if (!fs.existsSync(target)) continue;
      if (fs.statSync(target).isDirectory()) fs.rmSync(target, { recursive: true, force: true });
      else fs.rmSync(target, { force: true });
    }
    const meta = path.join(chats, cid, 'meta.json');
    if (fs.existsSync(meta)) fs.rmSync(meta, { force: true });
  }
  fs.writeFileSync(index, JSON.stringify(keep, null, 2), 'utf8');
  for (const name of ['a2a-reception-ledger.json', 'a2a-instructions.jsonl']) {
    const file = path.join(root, 'local', name);
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  }
  // `A2A_RESET_CONTACTS=1`：连本地联系人缓存一起清（Hub 才是关系权威），
  // 配合 `--no-contact` 的 fixture 就回到「还没加好友」的状态。
  if (process.env.A2A_RESET_CONTACTS === '1') {
    for (const name of ['contacts.json', 'contact-requests.json', 'contact-history.jsonl']) {
      const file = path.join(root, 'local', name);
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    }
  }
  console.log(`cleaned ${removed} a2a conversation(s):`, root);
}
/**
 * 本地清完还不够：Hub 的 relay 是「取走即删」，之前没被消费的消息会在客户端启动时
 * 被拉下来，又长出一条 A2A 会话。这里顺手把两端的队列排空（Hub 不可达就跳过）。
 */
const FIXTURE = path.join(os.homedir(), '.cogseed', 'a2a-dev', 'fixture.json');
const HUB = process.env.A2A_HUB_URL || 'http://127.0.0.1:4202';
if (fs.existsSync(FIXTURE)) {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  for (const who of ['A', 'B']) {
    const token = fixture?.[who]?.token;
    if (!token) continue;
    for (let i = 0; i < 5; i += 1) {
      try {
        const res = await fetch(`${HUB}/api/v1/a2a/relay/messages`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const json = await res.json().catch(() => null);
        const count = Array.isArray(json?.data?.messages) ? json.data.messages.length : 0;
        if (!count) break;
        console.log(`drained ${count} queued relay message(s) for ${who}`);
      } catch {
        console.log(`hub unreachable; skipped drain for ${who}`);
        break;
      }
    }
  }
}

console.log('done — restart both clients before testing.');
