#!/usr/bin/env npx tsx
/**
 * transcript-correction-compare — 纠错链路**改前/改后对照**（只读，不写任何文件）
 *
 * 为什么要有这个脚本：本轮改造（①多路召回接线 ②场景标签进链路 ③引例语境闸）的验收
 * 口径是产品侧定的两条——**"纠错能力是否提升"** 与 **"是否会误改原文"**。
 * 这两条都不能靠"代码合了"回答，必须对同一份真实转写跑两遍、把数字摆出来。
 *
 * 用法：
 *   npx tsx scripts/transcript-correction-compare.ts <转写文件> [--doc <docId>] [--tags a,b] [--json]
 *
 * 输出四组对照（全部基于**同一份词表种子** `INITIAL_GLOSSARY_SEED`，不读用户数据）：
 *   ① 候选总数：改前（字面命中）/ 改后（+多路召回），以及改后按通道拆分；
 *   ② 引例候选：有多少候选落在"讲拼写/识别/纠错本身"的句子里（改前一律会被默认改掉）；
 *   ③ **默认应用（不勾选任何一项、按风险等级全应用）会改动多少处**——这是"误改面"的直接度量；
 *   ④ 改后新增的模糊候选清单（逐条给 span 与上下文，供人工判定"准不准"）。
 *
 * 设计原则：**只报告事实**。本脚本不判定"某个形态应该改成什么"，也不宣称准确率——
 * 那是人工标注集（COGSEED-314.11）的职责。这里只回答"这次改动把哪些数字动了"。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// paths.ts 在导入时要求工作区根目录；本脚本只读转写、不写用户数据，故指向临时目录。
// 必须在任何 src/main 模块导入之前设置，因此下面全部用动态 import。
process.env.COGSEED_WORKSPACE_ROOT = process.env.COGSEED_WORKSPACE_ROOT
  || fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-correction-compare-'));

main().catch((error) => {
  console.error('[compare] 失败：', error);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const { INITIAL_GLOSSARY_SEED } = await import('../src/main/features/transcript_glossary_seed');
  const { defaultBoundary } = await import('../src/main/features/transcript_glossary');
  const { applyCorrections, scanText } = await import('../src/main/features/transcript_auto_correct');
  const { buildFuzzyCandidates } = await import('../src/main/features/transcript_recall_bridge');
  type GlossaryEntry = import('../src/main/features/transcript_glossary').GlossaryEntry;

  const argv = process.argv.slice(2);
  const file = argv.find((item) => !item.startsWith('--'));
  const docArg = argv.indexOf('--doc');
  const tagsArg = argv.indexOf('--tags');
  const asJson = argv.includes('--json');
  if (!file) {
    console.error('用法: npx tsx scripts/transcript-correction-compare.ts <转写文件> [--doc <docId>] [--tags a,b] [--json]');
    process.exitCode = 1;
    return;
  }
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    console.error(`[compare] 文件不存在：${abs}`);
    process.exitCode = 1;
    return;
  }
  const docId = docArg >= 0 ? String(argv[docArg + 1] ?? '') : undefined;
  const scenarioTags = tagsArg >= 0
    ? String(argv[tagsArg + 1] ?? '').split(',').map((t) => t.trim()).filter(Boolean)
    : [];

  const text = fs.readFileSync(abs, 'utf8');
  const entries: GlossaryEntry[] = INITIAL_GLOSSARY_SEED.map((row, index) => ({
    id: `g_seed${index + 1}`,
    wrong: row.wrong,
    correct: row.correct,
    action: 'replace',
    kind: row.kind,
    riskLevel: row.riskLevel,
    boundary: defaultBoundary(row.wrong, 'replace'),
    contextDeny: [],
    contextAllow: [],
    scope: { docIds: [], scenarioTags: [], global: true },
    freq: 0,
    source: 'manual',
    status: 'active',
    ownerScope: 'personal',
    replacedIn: [],
    createdBy: 'manual',
    createdAt: 1,
    updatedAt: 1,
    lastVerifiedAt: 1,
  }));

  const scanOptions = {
    ...(docId ? { docId } : {}),
    ...(scenarioTags.length ? { scenarioTags } : {}),
  };

  // ── 改前：只有字面命中，且**没有引例闸**（复现改动前的行为） ────────────
  //
  // 注意：`scanText` 现在自己就带引例闸，所以「改前」不能直接拿它的输出当基线，
  // 否则两列永远相同（第一版本脚本就踩了这个坑，被探针样本抓出来）。
  // 复现方式是**把闸门剥掉**：去掉 `quotedExample/quotedBy`、并把 `quoted_` 前缀还原，
  // 得到的就是"改动前那条路会看到什么"。
  const scanBefore = scanText(text, entries, scanOptions);
  const legacyCandidates = scanBefore.candidates.map((candidate) => ({
    ...candidate,
    entryRef: candidate.entryRef.replace(/^quoted_/, ''),
    quotedExample: undefined,
    quotedBy: undefined,
  }));
  const beforeApply = applyCorrections(text, legacyCandidates, {});

  // ── 改后：字面命中（含引例闸）+ 多路召回（模糊候选永不预勾） ──────────
  const before = scanBefore;
  const fuzzy = buildFuzzyCandidates(text, entries, {
    ...scanOptions,
    existingSpans: before.candidates.filter((c) => c.action !== 'delete').map((c) => c.span),
  });
  const afterCandidates = [...before.candidates, ...fuzzy.candidates];
  const afterApply = applyCorrections(text, afterCandidates, {});

  const quotedBefore = before.candidates.filter((c) => c.quotedExample === true);
  const quotedAfter = afterCandidates.filter((c) => c.quotedExample === true);
  const fuzzyQuoted = fuzzy.candidates.filter((c) => c.quotedExample === true);

  /** 默认应用改动的"处"（按 spans 数，而不是按词条行数）。 */
  const changesOf = (applied: Array<{ spans: Array<{ start: number }> }>) =>
    applied.reduce((sum, item) => sum + item.spans.length, 0);

  // 「引例处被默认改掉」= 改动 span 落在引例候选的 span 上（引例判定只作定位，不作真值）
  // 引例位置的真值 = 改后路径标出来的那些 span（闸门只作定位，不作"对不对"的判定）
  const quotedSpans = quotedAfter.map((c) => c.span);
  const countQuotedChanges = (result: ReturnType<typeof applyCorrections>) => {
    let hits = 0;
    for (const item of result.applied) {
      for (const span of item.spans) {
        if (quotedSpans.some((q) => span.start < q.end && span.end > q.start)) hits += 1;
      }
    }
    return hits;
  };

  const report = {
    file: path.basename(abs),
    chars: text.length,
    glossaryEntries: entries.length,
    before: {
      candidates: before.candidates.length,
      appliedSpans: changesOf(beforeApply.applied),
      quotedCandidates: quotedBefore.length,
      quotedAppliedSpans: countQuotedChanges(beforeApply),
      retention: Number(beforeApply.retention.toFixed(4)),
    },
    after: {
      candidates: afterCandidates.length,
      fuzzyCandidates: fuzzy.candidates.length,
      fuzzyByChannel: fuzzy.stats.byChannel,
      fuzzySkippedOverlap: fuzzy.stats.skippedOverlap,
      fuzzySkippedNormalized: fuzzy.stats.skippedNormalized,
      fuzzySkippedHighRisk: fuzzy.stats.skippedHighRisk,
      appliedSpans: changesOf(afterApply.applied),
      quotedCandidates: quotedAfter.length,
      quotedAppliedSpans: countQuotedChanges(afterApply),
      retention: Number(afterApply.retention.toFixed(4)),
    },
    fuzzyList: fuzzy.candidates.slice(0, 40).map((c) => ({
      ref: c.entryRef,
      wrong: c.wrong,
      correct: c.correct,
      channel: c.fuzzy?.channel,
      similarity: c.fuzzy?.similarity === undefined ? undefined : Number(c.fuzzy.similarity.toFixed(3)),
      disposition: c.fuzzy?.disposition,
      quoted: c.quotedExample === true,
      context: c.context.replace(/\s+/g, ' ').slice(0, 60),
    })),
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—');
  console.log(`\n# 纠错链路改前/改后对照 — ${report.file}`);
  console.log(`字数 ${report.chars} · 词表种子 ${report.glossaryEntries} 条 · doc=${docId ?? '(未传)'} · tags=${scenarioTags.join('|') || '(未传)'}\n`);
  console.log('| 指标 | 改前（仅字面命中，无引例闸） | 改后（+引例闸 +多路召回） |');
  console.log('| --- | --- | --- |');
  console.log(`| 候选总数 | ${report.before.candidates} | ${report.after.candidates}（+${report.after.fuzzyCandidates} 模糊） |`);
  console.log(`| 默认应用改动处数 | ${report.before.appliedSpans} | ${report.after.appliedSpans} |`);
  console.log(`| 其中落在引例句的处数 | ${report.before.quotedAppliedSpans} | ${report.after.quotedAppliedSpans} |`);
  console.log(`| 引例候选条数（可见但不预勾） | 0（无此概念） | ${report.after.quotedCandidates} |`);
  console.log(`| 字符保留率 | ${report.before.retention} | ${report.after.retention} |`);
  console.log(`\n模糊候选通道分布：${JSON.stringify(report.after.fuzzyByChannel)}`);
  console.log(`去重：与精确命中重复 ${report.after.fuzzySkippedOverlap} 条；归一化通道丢弃 ${report.after.fuzzySkippedNormalized} 条；高危词条过滤 ${report.after.fuzzySkippedHighRisk} 条`);
  console.log(`\n## 模糊候选（前 40 条，逐条给上下文供人工判定）`);
  for (const item of report.fuzzyList) {
    console.log(`- [${item.channel} ${item.similarity}] ${item.wrong} → ${item.correct}${item.quoted ? ' 〔引例〕' : ''} …${item.context}…`);
  }
  if (!report.fuzzyList.length) console.log('- （无）');
  console.log(`\n提示：本脚本只报告数字，不宣称准确率。准确率需要人工标注集（COGSED-314.11 的真实会议样本）。\n`);
}
