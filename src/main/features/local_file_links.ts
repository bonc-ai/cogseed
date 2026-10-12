/**
 * 库内文件 ↔ 本机文件的对应关系（机器本地，不进同步）。
 *
 * 为什么需要（2026-09-23 真机反馈）：库里的文件是**复制**进来的
 * （`contexts.importContextFileFromPath`），复制完 App 就再也不知道原文躺在用户磁盘的
 * 哪个文件夹里。于是「另存到知识库」只能写回库内目录——用户用「在文件夹中显示」能看到
 * 清理版，但去自己放原文的文件夹（如 ~/Desktop/…/会议/）里找不到，反馈原话就是
 * "文字转写清理版没有保存到本地"。
 *
 * 存在哪：`<uid>/local/contexts/.kb/local-file-links.json`。
 * 绝对路径只在本机有意义（换机器/换盘符即失效），与 `granted-roots.json` 同属机器私有
 * 状态，**不能跨设备同步**——所以放 local 侧、放 KB 自己的 `.kb/` 目录下（隐藏、不进列表）。
 *
 * 两类**证据**（都不是猜的，都有用户动作背书）：
 *   - `import`    —— 导入时记下的源文件（用户把这份文件从那个文件夹导进来的）；
 *   - `user_pick` —— 用户在一次系统保存框里选定的落点（他明确回答过"就放这儿"）。
 * 两者都只用来回答一个问题："这份文档在本机属于哪个文件夹？"——另存本地时写回那里，
 * 免得同一份稿子每次都要用户重新导航一遍。
 *
 * 口径（三条都要守）：
 *   1. 台账只是**线索**，不是事实来源：每次用之前都要复核目录还在不在（原件被删/改名/
 *      换机器都会让线索失效），失效就返回 null 让调用方退回系统保存框；
 *   2. **只记不改业务数据**，读写一律不抛：台账是旁路，不能因为它出错把用户的导入搞挂；
 *   3. 条目有上限（超出丢最旧），避免长年累积成一个无限增长的文件。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { userKbDir } from '../paths';
import { readJsonSync, writeJsonSync } from '../storage';
import { createLogger } from '../logger';

const log = createLogger('local-file-links');

/** 台账文件名（位于 `<uid>/local/contexts/.kb/`，与 vector.db 同级）。 */
export const LOCAL_FILE_LINKS_FILENAME = 'local-file-links.json';

/** 最多记多少条：一份库里的文件数量级在几百，2000 足够覆盖活跃集合，且文件仍是几百 KB。 */
export const MAX_LOCAL_FILE_LINKS = 2000;

export type LocalLinkSource = 'import' | 'user_pick';

export interface LocalFileLink {
  /** 本机绝对路径：导入来源文件，或用户选定的落点文件。 */
  targetAbs: string;
  /** 线索来源（导入 / 用户手选）。 */
  from: LocalLinkSource;
  /** 记录时间（ms）。 */
  at: number;
}

interface Store {
  version: 1;
  /** key = 库内相对路径（'/' 分隔、无首尾斜杠）。 */
  entries: Record<string, LocalFileLink>;
}

export function linksFileForUser(userId: string): string {
  return path.join(userKbDir(userId), LOCAL_FILE_LINKS_FILENAME);
}

/**
 * 台账 key 归一化：`\` → `/`、去首尾斜杠。
 *
 * 空串、`.`/`..` 段、以 `.` 开头的隐藏段一律返回空串（拒绝记账）：这些路径要么非法，
 * 要么属于 `.kb/`、本体分组那类内部目录——它们不是用户导入的文件，也不该有"本机对应"。
 */
export function normalizeLibraryKey(relPath: string): string {
  const raw = String(relPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!raw) return '';
  const segments = raw.split('/');
  if (segments.some((s) => !s || s === '.' || s === '..' || s.startsWith('.'))) return '';
  return segments.join('/');
}

function emptyStore(): Store {
  return { version: 1, entries: {} };
}

function readStore(userId: string): Store {
  const parsed = readJsonSync<Store>(linksFileForUser(userId));
  if (!parsed || typeof parsed !== 'object' || !parsed.entries || typeof parsed.entries !== 'object') {
    return emptyStore();
  }
  const entries: Record<string, LocalFileLink> = {};
  for (const [key, value] of Object.entries(parsed.entries)) {
    const targetAbs = typeof value?.targetAbs === 'string' ? value.targetAbs : '';
    if (!key || !targetAbs || !path.isAbsolute(targetAbs)) continue;
    entries[key] = {
      targetAbs,
      from: value?.from === 'user_pick' ? 'user_pick' : 'import',
      at: Number(value?.at) || 0,
    };
  }
  return { version: 1, entries };
}

/**
 * 写一条线索。**失败只 warn**：导入/导出都已经成功了，台账丢了最坏结果是"下次再问一遍位置"，
 * 不该让主流程失败。
 */
function writeLink(userId: string, relPath: string, link: Omit<LocalFileLink, 'at'>): void {
  const key = normalizeLibraryKey(relPath);
  if (!key || typeof link.targetAbs !== 'string' || !path.isAbsolute(link.targetAbs)) return;
  try {
    const store = readStore(userId);
    store.entries[key] = { ...link, at: Date.now() };
    const keys = Object.keys(store.entries);
    if (keys.length > MAX_LOCAL_FILE_LINKS) {
      const newest = keys
        .sort((a, b) => (store.entries[b]?.at || 0) - (store.entries[a]?.at || 0))
        .slice(0, MAX_LOCAL_FILE_LINKS);
      const kept: Record<string, LocalFileLink> = {};
      for (const k of newest) kept[k] = store.entries[k];
      store.entries = kept;
    }
    writeJsonSync(linksFileForUser(userId), store);
  } catch (err) {
    log.warn('write local file link failed', { error: (err as Error)?.message || String(err) });
  }
}

/** 记"这份库内文件来自本机哪个源文件"（导入时调用）。 */
export function recordImportLinkForUser(userId: string, relPath: string, sourceAbs: string): void {
  writeLink(userId, relPath, { targetAbs: sourceAbs, from: 'import' });
}

/** 记"用户把这份文档的本机产物放在了哪里"（系统保存框返回后调用）。 */
export function recordUserPickedTargetForUser(userId: string, relPath: string, targetAbs: string): void {
  writeLink(userId, relPath, { targetAbs, from: 'user_pick' });
}

/** 查一条线索（不校验目录是否还在，见 `localWriteDirForUser`）。 */
export function localFileLinkForUser(userId: string, relPath: string): LocalFileLink | null {
  const key = normalizeLibraryKey(relPath);
  if (!key) return null;
  try {
    return readStore(userId).entries[key] ?? null;
  } catch (err) {
    log.warn('read local file link failed', { error: (err as Error)?.message || String(err) });
    return null;
  }
}

/**
 * 可用作"写回本机文件夹"的目标目录：线索里那个目录**当前仍然存在且是目录**时才返回，
 * 否则 null（调用方退回系统保存框）。
 *
 * 只看目录、不要求原文件还在：用户把原稿改名/挪到同目录的其它名字下很常见，
 * 那仍然是"他自己放这批资料的文件夹"，写进去不会变成陌生位置。
 */
export function localWriteDirForUser(userId: string, relPath: string): string | null {
  const link = localFileLinkForUser(userId, relPath);
  if (!link) return null;
  const dir = path.dirname(link.targetAbs);
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  return dir;
}
