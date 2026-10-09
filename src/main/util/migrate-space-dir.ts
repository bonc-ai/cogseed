/**
 * 空间内容目录命名迁移：`cloud/spaces/<sid>/` → `cloud/spaces/<空间名>/`。
 *
 * 空间内容目录原先固定以 space_id 命名，访达/资源管理器里显示的文件夹名与
 * 空间名不一致。新的命名约定：目录名跟随空间名（创建/改名时同步），真实归属
 * 由目录内 `.space-id` 标记文件绑定（见 paths.ts 的 spaceContentDir 解析器）。
 *
 * 本迁移把存量的 `<sid>` 命名目录改名为空间名并写入标记：
 *   - 幂等：目录里已有 `.space-id` 标记（无论内容）即视为已迁移，直接跳过；
 *   - 只处理以 `sp_` 开头的目录（旧命名特征；空间名目录不会以 sp_ 开头）；
 *   - 空间名经 sanitizeSpaceDirName 净化，与既有目录重名时追加 ` (N)` 后缀；
 *   - 同一 sid 已存在带标记的目录时跳过旧目录（避免分裂成两个目录）；
 *   - 改名失败（目录被占用等）只告警不抛出——解析器会回退旧 `<sid>` 目录，
 *     功能不受影响，下次启动再收敛。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  spaceMetaFile,
  userSpacesDir,
  SPACE_DIR_MARKER,
  invalidateSpaceDirCache,
  sanitizeSpaceDirName,
} from '../paths';
import { createLogger } from '../logger';

const log = createLogger('migrate-space-dir');

export function migrateSpaceDirNames(uid: string): void {
  const root = userSpacesDir(uid);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return; // spaces 根不存在：无存量可迁移
  }
  const dirNames = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
  const markerSidOf = (dirName: string): string | null => {
    try {
      return fs.readFileSync(path.join(root, dirName, SPACE_DIR_MARKER), 'utf8').trim() || null;
    } catch {
      return null;
    }
  };
  const taken = (name: string, self: string) => name !== self && dirNames.has(name);

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dirName = e.name;
    // 旧命名特征：<sid> 目录以 sp_ 开头；空间名目录不会
    if (!dirName.startsWith('sp_')) continue;
    // 已有标记 → 已是命名目录（或曾迁移过），跳过
    if (markerSidOf(dirName) !== null) continue;
    const sid = dirName;
    // 同一 sid 已存在命名目录 → 旧目录成孤儿，跳过避免分裂
    let alreadyNamed = false;
    for (const other of dirNames) {
      if (other !== dirName && markerSidOf(other) === sid) { alreadyNamed = true; break; }
    }
    if (alreadyNamed) {
      log.warn(`space dir split-brain (named dir already exists) uid=${uid} sid=${sid}, legacy dir kept as-is`);
      continue;
    }
    let spaceName = '';
    try {
      const raw = fs.readFileSync(spaceMetaFile(uid, sid), 'utf8');
      const meta = JSON.parse(raw);
      if (meta && typeof meta.name === 'string') spaceName = meta.name;
    } catch (err) {
      log.warn(`read space meta failed (skip rename) uid=${uid} sid=${sid}: ${(err as Error).message}`);
      continue;
    }
    const base = sanitizeSpaceDirName(spaceName, sid);
    let target = base;
    for (let i = 2; taken(target, dirName) && i < 1000; i++) target = `${base} (${i})`;
    try {
      fs.renameSync(path.join(root, dirName), path.join(root, target));
      fs.writeFileSync(path.join(root, target, SPACE_DIR_MARKER), `${sid}\n`);
      dirNames.delete(dirName);
      dirNames.add(target);
      invalidateSpaceDirCache(uid, sid);
      log.info(`space dir renamed uid=${uid} sid=${sid} "${dirName}" -> "${target}"`);
    } catch (err) {
      log.warn(`rename space dir failed uid=${uid} sid=${sid}: ${(err as Error).message}`);
    }
  }
}
