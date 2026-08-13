/**
 * 空间产物聚合（空间化重构阶段 1 / T1.2）—— 空间「产物」tab 数据源。
 *
 * 遍历空间下会话，聚合两类产物：
 *   - 附件（attachment）：`cloud/spaces/<sid>/chat_attachments/<cid>/` 下的文件；
 *   - 交互产物（artifact）：`cloud/spaces/<sid>/chat_artifacts/<cid>/<aid>/` 目录
 *     （web app，读 `__cogseed-meta.json` 取标题/创建时间）。
 *
 * 为什么直接扫空间路径而不是复用 `chat_attachments.listAttachments` /
 * `artifactDirForConversation`：后两者经 `project-layout` 按 `project_id` 解析
 * 到 projects/ 或全局根，尚未支持空间根（阶段 4 T4.1 才改）。v5 迁移已把已绑空间
 * 会话的附件/产物搬到 `spaces/<sid>/`，故本模块直接读空间目录，与迁移落点对齐。
 * 阶段 4 统一路径解析后可再收敛。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { spaceChatAttachmentDir, spaceChatArtifactCidDir } from '../paths';
import { ALLOWED_EXTENSIONS } from './chat_attachments';
import { listSpaceConversations } from './chats';

const ARTIFACT_META_FILENAME = '__cogseed-meta.json';

export type SpaceArtifactType = 'attachment' | 'artifact';

export interface SpaceArtifactEntry {
  /** 附件 = 文件名；artifact = 标题（缺省用 artifactId）。 */
  name: string;
  type: SpaceArtifactType;
  /** 小写扩展名（含点）；artifact 固定 '.html'（入口 index.html）。 */
  ext: string;
  /** 来源会话 id（cid）。 */
  sourceSessionId: string;
  /** 时间戳（秒）：附件 = mtime，artifact = meta.createdAt 或目录 mtime。 */
  time: number;
  /** 仅 artifact：产物目录 id。 */
  artifactId?: string;
}

function scanAttachments(uid: string, spaceId: string, cid: string, out: SpaceArtifactEntry[]): void {
  const dir = spaceChatAttachmentDir(uid, spaceId, cid);
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith('.')) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) continue;
    let mtime = 0;
    try { mtime = Math.floor(fs.statSync(path.join(dir, e.name)).mtimeMs / 1000); } catch { /* keep 0 */ }
    out.push({ name: e.name, type: 'attachment', ext, sourceSessionId: cid, time: mtime });
  }
}

function scanArtifacts(uid: string, spaceId: string, cid: string, out: SpaceArtifactEntry[]): void {
  const cidDir = spaceChatArtifactCidDir(uid, spaceId, cid);
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(cidDir, { withFileTypes: true }); }
  catch { return; }
  for (const d of entries) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const artifactId = d.name;
    const artDir = path.join(cidDir, artifactId);
    let name = artifactId;
    let time = 0;
    try {
      const raw = fs.readFileSync(path.join(artDir, ARTIFACT_META_FILENAME), 'utf8');
      const meta = JSON.parse(raw) as { title?: unknown; createdAt?: unknown };
      if (typeof meta?.title === 'string' && meta.title.trim()) name = meta.title.trim();
      const t = Date.parse(String(meta?.createdAt || ''));
      if (Number.isFinite(t)) time = Math.floor(t / 1000);
    } catch { /* missing / malformed meta */ }
    if (!time) {
      try { time = Math.floor(fs.statSync(artDir).mtimeMs / 1000); } catch { /* keep 0 */ }
    }
    out.push({ name, type: 'artifact', ext: '.html', sourceSessionId: cid, time, artifactId });
  }
}

/** 空间产物聚合：附件 + artifact 统一列表，按时间倒序。空空间返回空数组（不 mock）。 */
export async function listSpaceArtifacts(uid: string, spaceId: string): Promise<SpaceArtifactEntry[]> {
  if (!spaceId) return [];
  const conversations = await listSpaceConversations(uid, spaceId);
  const out: SpaceArtifactEntry[] = [];
  for (const c of conversations) {
    scanAttachments(uid, spaceId, c.conversation_id, out);
    scanArtifacts(uid, spaceId, c.conversation_id, out);
  }
  out.sort((a, b) => b.time - a.time);
  return out;
}
