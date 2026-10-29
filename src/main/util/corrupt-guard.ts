/**
 * corrupt-guard — 用户数据文件的坏档备份、拒写与恢复。
 *
 * 三处同构点共用：转写词表（transcript-glossary.json）、本体候选池
 * （candidates.md）、个人本体（personal-ontology.json）。旧病相同：读侧把
 * 坏档/读错当空数据吞掉 → 下一次写全量覆写 → 原数据静默丢失且无备份。
 *
 * 处理顺序：
 *  1. 读到坏档（非 ENOENT 的读错，或内容解析失败）→ 先 **copy**（不动原文件）
 *     到 `<file>.corrupt-<时间戳>` 备份；
 *  2. 写侧拒绝：坏档登记为内存 latch（不依赖备份文件是否还在——备份被移走
 *     也不失效），写原语 throw CorruptFileError / 返回失败中止。只有**真
 *     ENOENT**（文件确实不存在）才允许空初始化后落盘；
 *  3. 恢复入口：restore（最新备份 copy 回原位）/ reset（删除坏档原文件，
 *     备份保留）→ 清 latch。产品内「从备份恢复/重置」复用同一入口。
 *
 * 为什么 copy 不 move：move 之后下次读 = ENOENT → 空初始化 → 「拒绝覆盖」
 * 永不触发，坏档可能被空数据覆盖。
 *
 * latch 生命周期：读成功即自愈清除（文件被外部修好/云同步还原后写能力自动
 * 恢复）；进程重启后 latch 清空，但坏档文件的首次读取会重新检测并重新登记
 * （同一进程内重复读不重复拷贝备份，restore/reset 后的再次坏档会另立备份）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../logger';

const log = createLogger('corrupt-guard');

/** 坏档登记项（内存 latch；filePath 为绝对路径，不出渲染进程）。 */
export interface CorruptRecord {
  filePath: string;
  /** 业务域名（渲染层展示与恢复通道寻址用）：transcript-glossary /
   *  ontology-candidates / po。 */
  domain: string;
  reason: string;
  at: string;
  backupPath?: string;
}

const corruptFiles = new Map<string, CorruptRecord>();

/** 写原语统一抛的结构化错误（code 会经 IPC 信封带回渲染层）。 */
export class CorruptFileError extends Error {
  readonly code = 'cognition_file_corrupt';
  readonly record: CorruptRecord;
  constructor(record: CorruptRecord) {
    super(`${record.domain} data file is corrupt; write refused: ${record.reason}`);
    this.name = 'CorruptFileError';
    this.record = record;
  }
}

function backupStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * 登记一处坏档（第一步：copy 备份）。幂等去重：同一文件在本进程内已登记且
 * 已有备份时不重复拷贝；latch 曾被「读成功自愈」清掉又因解析失败重新登记
 * （字节可读但内容坏的场景每次读都会走这里）时，先比对已有备份内容——
 * 字节相同就复用，不堆同内容备份；内容变了（再次坏档/坏法不同）才另立。
 * 备份拷贝失败不阻止登记——拒写防线不依赖备份存在。
 */
export function reportCorruptFile(
  filePath: string,
  reason: string,
  opts: { domain?: string } = {},
): CorruptRecord {
  const domain = opts.domain || path.basename(filePath);
  const existing = corruptFiles.get(filePath);
  let backupPath = existing?.backupPath;
  if (!backupPath) {
    for (const name of listCorruptBackups(filePath)) {
      const candidate = path.join(path.dirname(filePath), name);
      try {
        if (fs.readFileSync(candidate).equals(fs.readFileSync(filePath))) {
          backupPath = candidate;
          break;
        }
      } catch { /* 比对失败就走正常拷贝 */ }
    }
  }
  if (!backupPath) {
    try {
      const target = `${filePath}.corrupt-${backupStamp()}`;
      fs.copyFileSync(filePath, target); // copy：原文件保持原位原样
      backupPath = target;
    } catch (err) {
      log.warn('corrupt backup copy failed (guard still engages)', {
        filePath, error: (err as Error).message,
      });
    }
  }
  const record: CorruptRecord = {
    filePath,
    domain,
    reason,
    at: new Date().toISOString(),
    ...(backupPath ? { backupPath } : {}),
  };
  corruptFiles.set(filePath, record);
  log.warn('user data file corrupt; writes refused until restore/reset', {
    filePath, domain, reason, backupPath: backupPath || null,
  });
  return record;
}

export type GuardedReadResult =
  | { status: 'ok'; text: string }
  | { status: 'missing' }
  | { status: 'corrupt'; record: CorruptRecord };

/**
 * 受守卫的文本读取：ENOENT → missing（合法空初始化的唯一入口）；其它读错 →
 * copy 备份 + 登记 + corrupt；读成功 → 清 latch（自愈：文件被修好后写能力恢复）。
 * 内容级坏档（JSON.parse 失败等）由调用方在解析失败处调 reportCorruptFile。
 */
export function readTextGuarded(
  filePath: string,
  opts: { domain?: string } = {},
): GuardedReadResult {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') return { status: 'missing' };
    return {
      status: 'corrupt',
      record: reportCorruptFile(filePath, `read failed: ${code || (err as Error).message}`, opts),
    };
  }
  corruptFiles.delete(filePath);
  return { status: 'ok', text };
}

/** 写原语门：坏档已登记则抛 CorruptFileError（备份被移走不影响判定）。 */
export function assertNotCorrupt(filePath: string): void {
  const record = corruptFiles.get(filePath);
  if (record) throw new CorruptFileError(record);
}

export function corruptRecordFor(filePath: string): CorruptRecord | undefined {
  return corruptFiles.get(filePath);
}

/** 渲染层可见的坏档清单（不含绝对路径）。 */
export interface CorruptRecordView {
  domain: string;
  reason: string;
  at: string;
  file: string;
  backupCount: number;
}

export function listCorruptRecords(): CorruptRecordView[] {
  return [...corruptFiles.values()].map((r) => ({
    domain: r.domain,
    reason: r.reason,
    at: r.at,
    file: path.basename(r.filePath),
    backupCount: listCorruptBackups(r.filePath).length,
  }));
}

/** 磁盘上的坏档备份（旧→新）：`<basename>.corrupt-<stamp>` 同目录兄弟文件。 */
export function listCorruptBackups(filePath: string): string[] {
  try {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    return fs.readdirSync(dir)
      .filter((name) => name.startsWith(`${base}.corrupt-`))
      .sort();
  } catch {
    return [];
  }
}

/** 恢复：最新备份 copy 回原位，清 latch。备份内容若仍坏，下次读取会重新登记。 */
export function restoreCorruptFile(
  filePath: string,
): { ok: boolean; error?: string; restoredFrom?: string } {
  const backups = listCorruptBackups(filePath);
  if (!backups.length) return { ok: false, error: 'no corrupt backup found' };
  const latest = path.join(path.dirname(filePath), backups[backups.length - 1]);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.copyFileSync(latest, filePath);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  corruptFiles.delete(filePath);
  log.info('corrupt file restored from backup', { filePath, restoredFrom: latest });
  return { ok: true, restoredFrom: latest };
}

/** 重置：删除坏档原文件（备份保留），清 latch → 下次读 = 真 ENOENT → 合法空初始化。 */
export function resetCorruptFile(filePath: string): { ok: boolean; error?: string } {
  try {
    fs.rmSync(filePath, { force: true });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  corruptFiles.delete(filePath);
  log.info('corrupt file reset (backups kept)', { filePath });
  return { ok: true };
}
