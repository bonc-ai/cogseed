/**
 * memory-migration.ts — 存量记忆迁移（2026-09-19 合并实施·清单 #6）。
 *
 * 产品形态：升级后一次性把 USER.md / MEMORY.md 的既有条目过第二段入库
 * （直投管线复用：注入扫描、查重金字塔、挂族、候选留痕），全部迁移完成后
 * 两个文件清空退役（阶段 D 的记忆退役前提）。
 *
 * 安全性：
 *  - 迁移前把两个文件原样备份到 cloud/memory-backup-<timestamp>/；
 *  - dryRun 只读不写（盘点模式）；
 *  - 单条失败不中断整批（计入 failed，条目保留在文件里等下次重跑）；
 *  - 迁移幂等：清空后重跑扫到 0 条，零副作用。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../../logger';
import { userMemoryFile, userProfileFile } from '../../paths';
import { loadMemoryRecords } from '../memory-records';

const log = createLogger('recall.memory-migration');

export interface MemoryMigrationReport {
  scannedUser: number;
  scannedShared: number;
  migrated: number;
  skippedNoText: number;
  /** 入库只到候选池（embedding 硬阻塞 / 查重命中等确认融合）的条数——
   *  这些条目保留在源文件里，没进资产库就不算迁移完成。 */
  pendingReview: number;
  failed: number;
  backupDir?: string;
  dryRun: boolean;
}

function backupFile(sourceFile: string, backupDir: string): boolean {
  try {
    if (!fs.existsSync(sourceFile)) return false;
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(sourceFile, path.join(backupDir, path.basename(sourceFile)));
    return true;
  } catch (error) {
    log.warn('memory migration backup failed', { sourceFile, error: (error as Error).message });
    return false;
  }
}

/** 迁移入口：读取两个记忆文件的条目 → 逐条直投入库 → 全部成功后清空文件。
 *  dryRun=true 只盘点（返回会迁多少条），不备份不写入。 */
export async function migrateLegacyMemoryToAssets(
  userId: string,
  opts: { dryRun?: boolean; files?: { user?: string; shared?: string } } = {},
): Promise<MemoryMigrationReport> {
  const dryRun = opts.dryRun === true;
  const report: MemoryMigrationReport = {
    scannedUser: 0, scannedShared: 0, migrated: 0, skippedNoText: 0, pendingReview: 0, failed: 0, dryRun,
  };
  // files 注入口：生产走 paths 默认；测试/迁移工具可显式指定（绕开 paths 的
  // 工作区根固化，也让"迁移哪个文件"可组合）。
  const files: Array<{ file: () => string; key: 'scannedUser' | 'scannedShared' }> = [
    { file: () => opts.files?.user || userProfileFile(userId), key: 'scannedUser' },
    { file: () => opts.files?.shared || userMemoryFile(userId), key: 'scannedShared' },
  ];

  const pending: Array<{ file: string; key: 'scannedUser' | 'scannedShared'; texts: string[] }> = [];
  for (const target of files) {
    const file = target.file();
    let texts: string[] = [];
    let blank = 0;
    try {
      // loadMemoryRecords 返回数组（不是 {records} 包装）。role_template 来源
      // 条目不迁：它们的家在模板独立文件/渲染层双源（迁移会把模板画像混进
      // personal 资产、清空文件后卸载也找不到条目可删——原地升级用户装着的
      // 模板会静默失效）。
      const rawTexts = loadMemoryRecords(file)
        .filter((record) => !record.sources.some((source) => source.kind === 'role_template'))
        .map((record) => String(record.text || '').trim());
      texts = rawTexts.filter(Boolean);
      blank = rawTexts.length - texts.length;
    } catch (error) {
      log.warn('memory migration read failed', { file, error: (error as Error).message });
    }
    report[target.key] = texts.length;
    report.skippedNoText += blank;
    if (texts.length) pending.push({ file, key: target.key, texts });
  }
  if (!pending.length) return report;
  if (dryRun) return report;

  // 迁移前备份（两个文件都备，哪怕其中一个为空——空文件也证明当时状态）。
  const backupDir = path.join(path.dirname(userMemoryFile(userId)), `memory-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  for (const target of pending) backupFile(target.file, backupDir);
  report.backupDir = backupDir;

  const { ingestImmediateKnowledge } = await import('./candidate-service');
  for (const target of pending) {
    let targetSucceeded = 0;
    for (const text of target.texts) {
      try {
        const result = await ingestImmediateKnowledge(userId, { text });
        if (result.mode === 'created' || result.mode === 'merged') {
          targetSucceeded += 1;
          report.migrated += 1;
        } else {
          // pending-review（embedding 硬阻塞）/ fused-update-pending（查重
          // 命中、等确认后融合）：内容只到候选池、没进资产库——不计入可清空
          // 口径。此前一律计成功，USER.md 被清空而画像其实停在「待我处理」
          // 里，用户不看候选池就等于丢失。条目保留在文件里：候选池按
          // captureKey 幂等，embedding 恢复或用户确认融合后重跑即收口。
          report.pendingReview += 1;
        }
      } catch (error) {
        // 单条失败（注入扫描拒收等）不中断整批；条目保留在文件里。
        report.failed += 1;
        log.warn('memory migration entry failed', { error: (error as Error).message, head: text.slice(0, 40) });
      }
    }
    // 本文件全部条目真正入库才清空；清空前重读比对——扫描到清空之间运行
    // 期写手（memory replace/remove、直投失败回退）可能写入新条目，清空不
    // 能把它们连带抹掉（那些条目从未迁移过）。
    if (targetSucceeded === target.texts.length && sourceUnchangedSinceScan(target.file, target.texts)) {
      try { fs.writeFileSync(target.file, '', 'utf8'); } catch (error) {
        log.warn('memory migration clear failed', { file: target.file, error: (error as Error).message });
      }
    } else if (targetSucceeded === target.texts.length) {
      log.info('memory migration clear deferred: file changed during migration (new entries kept for next run)', {
        file: target.file,
      });
    }
  }
  return report;
}

/** 清空前守卫：重读源文件，条目集合与扫描时一致才允许清空（防把迁移期间
 *  新写入的条目一并抹掉）。读失败按「已变化」处理——宁可不清空多跑一轮。 */
function sourceUnchangedSinceScan(file: string, texts: string[]): boolean {
  try {
    const current = loadMemoryRecords(file)
      .map((record) => String(record.text || '').trim())
      .filter(Boolean);
    return current.length === texts.length && current.every((text, i) => text === texts[i]);
  } catch {
    return false;
  }
}
