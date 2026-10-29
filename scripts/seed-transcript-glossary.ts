/**
 * 一次性种子脚本：把 26 条出厂术语灌进词表（**不再灌任何人名**）。
 *
 * 2026-10-21：个人名册种子已移除——词表改为“空起步”，人名由用户自己导入/确认，
 * 不再随代码分发。本脚本只保留产品术语（方案附 A），供需要时手动执行。
 *
 * 为什么写成脚本而不是手搓 JSON：
 *   词表条目的字段里有派生逻辑——风险等级（`effectiveRiskLevel` 的不可下调
 *   下限）、边界模式（`defaultBoundary`）、作用域归一化、幂等去重、ID 生成、
 *   以及"纯数字变体 / 单姓敬称"的拒绝入册。手写 JSON 会绕过这一整层，
 *   写出一份引擎读起来语义不对的文件。所以直接调 `features/transcript_glossary`
 *   的公开函数——与 App 运行时**走同一条代码路径**。
 *
 * 数据根：`COGSEED_WORKSPACE_ROOT` 必须指向真实数据根，否则 `paths.ts` 的
 *   `WS_ROOT` 会解析成别处，词表就写进了一个 App 不会读的目录。
 *
 * 用法：
 *   COGSEED_WORKSPACE_ROOT=<数据根> npx tsx scripts/seed-transcript-glossary.ts <uid>
 */

import { listEntries } from '../src/main/features/transcript_glossary';
import { INITIAL_GLOSSARY_SEED, seedInitialEntries } from '../src/main/features/transcript_glossary_seed';

function main(): void {
  const uid = process.argv[2];
  if (!uid) {
    console.error('[seed-glossary] 缺少 uid 参数');
    process.exit(2);
  }
  const root = process.env.COGSEED_WORKSPACE_ROOT;
  if (!root) {
    console.error('[seed-glossary] 必须设置 COGSEED_WORKSPACE_ROOT（否则会写到错误的数据根）');
    process.exit(2);
  }
  console.log(`[seed-glossary] 数据根: ${root}`);
  console.log(`[seed-glossary] uid   : ${uid}`);

  const before = listEntries(uid).length;
  console.log(`[seed-glossary] 灌入前词表条目数: ${before}`);

  // 26 条出厂术语（幂等：已存在的只更新规则字段，不改用户既有词条的写法与作用域）
  const seedResult = seedInitialEntries(uid);
  console.log(
    `[seed-glossary] 出厂术语: 新建 ${seedResult.created}，更新 ${seedResult.updated}，`
    + `跳过 ${seedResult.skipped.length}`,
  );
  for (const s of seedResult.skipped) {
    console.log(`[seed-glossary]   跳过 「${s.wrong}」: ${s.reason}`);
  }

  const entries = listEntries(uid);
  const byRisk: Record<string, number> = {};
  for (const e of entries) byRisk[e.riskLevel] = (byRisk[e.riskLevel] ?? 0) + 1;
  console.log(`[seed-glossary] 灌入后条目数: ${entries.length}`);
  console.log(
    `[seed-glossary] 风险分布: ${Object.entries(byRisk).map(([k, v]) => `${k}=${v}`).join(' ')}`,
  );
  console.log(`[seed-glossary] 出厂术语实际入册: ${entries.length} / ${INITIAL_GLOSSARY_SEED.length}`);
  console.log('[seed-glossary] 完成');
}

main();
