#!/usr/bin/env npx tsx
/**
 * transcript-clean-run — 转写清理管线的**驱动脚本**（把六段串起来并落盘）
 *
 * 用法：
 *   npx tsx scripts/transcript-clean-run.ts prepare  <源.txt> [--out <目录>]
 *   npx tsx scripts/transcript-clean-run.ts assemble <out目录>
 *   npx tsx scripts/transcript-clean-run.ts compare  <out目录> <人工清理版.md>
 *
 * 为什么要有这个 driver（而不是直接在应用里跑）：
 *   线上路径是 IPC/面板驱动、逐条人工确认的；但"跑通效果"需要一次性端到端跑完并留下
 *   可复核的产物。driver 只做**编排 + 落盘**，全部判定逻辑都在 `src/main/features/*`
 *   的纯函数里，所以这条链路和将来接进应用跑的是同一套代码。
 *
 * 六段与产物：
 *   ① 01-source.json        逐条发言（id 即锚点）
 *   ② 02-structure.json     口癖删除后的文本 + 删除统计
 *   ③ 03-normalized.json    实体归一（确定性通道自动、模糊通道只出候选）
 *   ④ 04-chunks/N.request.md 给模型的请求（分块）+ N.expected.json（本块锚点清单）
 *   ⑤ 05-verified.json      锚点校验结果 + issues + uncovered
 *   ⑥ 清理版.md + report.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

type Utterance = import('../src/main/features/transcript_rewrite').SourceUtterance;
type GlossaryEntry = import('../src/main/features/transcript_glossary').GlossaryEntry;
type VerifiedParagraph = import('../src/main/features/transcript_rewrite').VerifiedParagraph;

const CHUNK_MAX_UTTERANCES = 26;

/**
 * 除种子词表外，本次跑通**额外入册**的形态。
 *
 * 来源：2026-09-16 metrics 脚本产出的「建议入册清单」（`stats.residual` + 未召回归类），
 * 每一条都在真实上下文里核对过。**入册属人工决策**，故在此显式列名、并在产物的
 * 「未决项」里如实声明它们尚未经人工确认——不藏在代码里。
 */
const EXTRA_ENTRIES: Array<{ wrong: string; correct: string; kind: string; note: string }> = [
  { wrong: '静文', correct: '静雯', kind: 'people', note: 'metrics 实测 26 处；人工清理版也做了此归一' },
  { wrong: 'mesh seed', correct: 'MeshSeed', kind: 'product', note: '未召回 3 处' },
  { wrong: 'mesh c', correct: 'MeshSeed', kind: 'product', note: '未召回 1 处' },
  { wrong: '多维表', correct: '多维表格', kind: 'term', note: '未召回 2 处' },
  { wrong: '联盟德', correct: 'Raymond', kind: 'product', note: '未召回 1 处（中文音近，本层无拼音表）' },
  // ⚠️ 刻意**不**入册 `k42` / `k32`（2026-09-16 两次判断后的结论）：
  //   这两处出现在**引例语境**里——U0363「他不知道 k32 啥意思……包括我们这个 k32 记录」，
  //   说话人正是在抱怨"转写把 KSTAR 写成了 k32"。也就是说 k32/k42 是**要被展示的错误样例**，
  //   入册会让管线自动把它们抹平，反而破坏语义（正是失败模式 6）。
  //   我曾先把它们入册当成"补覆盖"，读了上下文后撤回——**"残留"既可能是漏改，也可能是正确保留**。
  { wrong: 'personality', correct: 'Personal Ontology', kind: 'term', note: '未召回 4 处；riskLevel=high 待确认' },
  { wrong: 'coseat', correct: 'Cogseed', kind: 'product', note: 'metrics 核对为真实变体' },
  { wrong: 'codeset', correct: 'Cogseed', kind: 'product', note: 'metrics 核对为真实变体' },
  { wrong: 'cock seed', correct: 'Cogseed', kind: 'product', note: 'metrics 核对为真实变体' },
  { wrong: 'cocet', correct: 'Cogseed', kind: 'product', note: 'metrics 核对为真实变体' },
  { wrong: 'cocket', correct: 'Cogseed', kind: 'product', note: 'metrics 核对为真实变体' },
  { wrong: 'car seat', correct: 'Cogseed', kind: 'product', note: 'metrics 核对为真实变体（上下文主语是 Cogseed）' },
  { wrong: 'personal oncology', correct: 'Personal Ontology', kind: 'term', note: 'metrics 核对为真实变体' },
];

main().catch((err) => {
  console.error('[clean] 失败：', err);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  process.env.COGSEED_WORKSPACE_ROOT = process.env.COGSEED_WORKSPACE_ROOT || '/tmp/cogseed-clean-run';
  if (cmd === 'prepare') return prepare(rest);
  if (cmd === 'assemble') return assemble(rest);
  if (cmd === 'compare') return compare(rest);
  if (cmd === 'chunkcheck') return chunkcheck(rest);
  console.error('用法: prepare <源.txt> [--out dir] | assemble <dir> | chunkcheck <dir> [min] [max] | compare <dir> <参考.md>');
  process.exitCode = 1;
}

// ── 词表 ────────────────────────────────────────────────────────────────

async function buildEntries(): Promise<GlossaryEntry[]> {
  const { INITIAL_GLOSSARY_SEED } = await import('../src/main/features/transcript_glossary_seed');
  const { defaultBoundary } = await import('../src/main/features/transcript_glossary');
  let seq = 0;
  const entries: GlossaryEntry[] = INITIAL_GLOSSARY_SEED.map((r) => {
    seq += 1;
    return {
      id: `seed_${seq}`, wrong: r.wrong, correct: r.correct, action: 'replace',
      kind: r.kind, riskLevel: r.riskLevel, boundary: defaultBoundary(r.wrong, 'replace'),
      contextDeny: [], contextAllow: [], scope: { docIds: [], scenarioTags: [], global: true },
      freq: 0, source: 'manual', status: 'active', ownerScope: 'personal',
      replacedIn: [], createdBy: 'manual', createdAt: 1, updatedAt: 1, lastVerifiedAt: 1,
    };
  });
  for (const e of EXTRA_ENTRIES) {
    seq += 1;
    entries.push({
      id: `extra_${seq}`, wrong: e.wrong, correct: e.correct, action: 'replace',
      kind: e.kind as GlossaryEntry['kind'],
      riskLevel: e.wrong === 'personality' ? 'high' : 'low',
      boundary: defaultBoundary(e.wrong, 'replace'),
      contextDeny: [], contextAllow: [], scope: { docIds: [], scenarioTags: [], global: true },
      freq: 0, source: 'ontology_seed', status: 'active', ownerScope: 'personal',
      replacedIn: [], createdBy: 'harvest', createdAt: 1, updatedAt: 1, lastVerifiedAt: 0,
    });
  }
  return entries;
}

// ── ① prepare ───────────────────────────────────────────────────────────

async function prepare(args: string[]): Promise<void> {
  const src = args.find((a) => !a.startsWith('--'));
  if (!src) { console.error('prepare 需要源文件路径'); process.exitCode = 1; return; }
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? args[outIdx + 1] : path.join(path.dirname(path.resolve(src)), `clean-run-${stamp()}`);
  fs.mkdirSync(path.join(outDir, '04-chunks'), { recursive: true });

  const raw = fs.readFileSync(src, 'utf-8');
  const sha1 = createHash('sha1').update(raw).digest('hex');
  fs.writeFileSync(path.join(outDir, 'source.sha1'), `${sha1}  ${path.basename(src)}\n`);

  const { parseSource, removeFillers, normalizeEntities } = await import('../src/main/features/transcript_clean_pipeline');
  const { buildRewriteRequest } = await import('../src/main/features/transcript_rewrite');
  const entries = await buildEntries();

  // ① 冻结与解析
  const source = parseSource(raw);
  writeJson(path.join(outDir, '01-source.json'), {
    source: path.basename(src), sourceDir: path.dirname(path.resolve(src)),
    sha1, count: source.length, utterances: source,
  });

  // ② 结构与口癖
  const { items, totals } = removeFillers(source);
  const byId = new Map(items.map((i) => [i.id, i.text]));
  const structured: Utterance[] = source.map((u) => ({ ...u, text: byId.get(u.id) ?? u.text }));
  writeJson(path.join(outDir, '02-structure.json'), {
    fillerTotals: totals,
    utterances: structured,
  });

  // ③ 实体归一（确定性通道自动替换；模糊通道只出候选）
  //
  // **设计要点（2026-09-16 修正）**：这一步的结果必须**真的应用**到后续输入上。
  // 原实现只把它写进 `03-normalized.json` 就丢掉了，交给 LLM 的仍是未归一文本——
  // 于是 k42/k32 的归一只靠模型自觉，结果它归了 k42 却漏了 k32（实测残留 2 处）。
  // 原则：**能机器确定的，在交给模型之前就做掉**，模型只处理真正有歧义的部分。
  // 锚点不受影响：归一不增删发言，id 与时间戳保持一一对应。
  const domTerms = [...new Set(entries.map((e) => e.correct))];
  const glossaryForModel = summarizeGlossary(entries);
  const appliedTally = new Map<string, { wrong: string; correct: string; channel: string; count: number }>();
  const pendingTally = new Map<string, { wrong: string; correct: string; channel: string; similarity: number }>();
  const normalizedUtterances: Utterance[] = structured.map((u) => {
    const r = normalizeEntities(u.text, entries, { domainTerms: domTerms, autoChannels: ['normalized'] });
    for (const a of r.applied) {
      const key = `${a.wrong}\u0000${a.correct}`;
      const cur = appliedTally.get(key);
      if (cur) cur.count += a.count; else appliedTally.set(key, { ...a });
    }
    for (const x of r.pending) {
      const key = `${x.wrong}\u0000${x.correct}`;
      if (!pendingTally.has(key)) pendingTally.set(key, x);
    }
    return { ...u, text: r.text };
  });
  const norm = {
    applied: [...appliedTally.values()].sort((a, b) => b.count - a.count),
    pending: [...pendingTally.values()],
  };
  writeJson(path.join(outDir, '03-normalized.json'), {
    applied: norm.applied, pending: norm.pending.slice(0, 400),
    pendingTotal: norm.pending.length,
    note: '本步骤结果已应用到 04-chunks 的输入文本（materials 即归一后文本）',
  });
  structured.length = 0;
  structured.push(...normalizedUtterances);

  // ④ 分块写请求（LLM 步骤由外部执行，回包写到同目录 N.response.md）
  const chunks: Utterance[][] = [];
  for (let i = 0; i < structured.length; i += CHUNK_MAX_UTTERANCES) {
    chunks.push(structured.slice(i, i + CHUNK_MAX_UTTERANCES));
  }
  const scenario = `这是《教育智能体演示汇报》的会议转写。参会人：${speakerList(structured)}。`
    + '讨论的是 Cogseed（个人 AI 伙伴客户端）、KSTAR、EduSeed、Forge 等产品的演示与落地。';
  chunks.forEach((chunk, i) => {
    const req = buildRewriteRequest(chunk, { scenario, glossary: glossaryForModel });
    const name = String(i + 1).padStart(2, '0');
    fs.writeFileSync(
      path.join(outDir, '04-chunks', `${name}.request.md`),
      [`# SYSTEM`, req.systemPrompt, '', `# USER`, req.message, ''].join('\n'),
    );
    writeJson(path.join(outDir, '04-chunks', `${name}.expected.json`), {
      ids: chunk.map((u) => u.id),
      speakers: [...new Set(chunk.map((u) => u.speaker))],
      chars: chunk.reduce((n, u) => n + u.text.replace(/\s/g, '').length, 0),
    });
  });

  console.log(`[prepare] 输出目录：${outDir}`);
  console.log(`  ① 源发言 ${source.length} 条（sha1 ${sha1.slice(0, 12)}）`);
  console.log(`  ② 口癖删除：${Object.entries(totals).map(([k, v]) => `${k}×${v}`).join(' ') || '（无）'}`);
  console.log(`  ③ 实体归一：自动替换 ${norm.applied.length} 种 / ${norm.applied.reduce((n, a) => n + a.count, 0)} 处；`
    + `模糊候选 ${norm.pending.length} 处（**未自动替换**）；确定性结果已应用到分块输入`);
  console.log(`  ④ 分块 ${chunks.length} 块 → 请对每块生成 04-chunks/NN.response.md`);
}

// ── ⑤⑥ assemble ─────────────────────────────────────────────────────────

async function assemble(args: string[]): Promise<void> {
  const outDir = args[0];
  if (!outDir) { console.error('assemble 需要 out 目录'); process.exitCode = 1; return; }
  const { verifyRewrite, parseRewriteResponse, applyQuotedFallback } = await import('../src/main/features/transcript_rewrite');
  const { mergeBlocks, renderMarkdown } = await import('../src/main/features/transcript_clean_pipeline');
  const entries = await buildEntries();

  const structured: Utterance[] = readJson(path.join(outDir, '02-structure.json')).utterances;
  const chunkDir = path.join(outDir, '04-chunks');
  const responses = fs.readdirSync(chunkDir).filter((f) => f.endsWith('.response.md')).sort();
  if (!responses.length) { console.error('没有找到 04-chunks/*.response.md'); process.exitCode = 1; return; }

  const parsed: Array<{ srcIds: string[]; text: string }> = [];
  const parseIssues: unknown[] = [];
  for (const f of responses) {
    const body = fs.readFileSync(path.join(chunkDir, f), 'utf-8');
    const r = parseRewriteResponse(body);
    parsed.push(...r.paragraphs);
    parseIssues.push(...r.issues.map((i) => ({ file: f, ...i })));
  }

  const allowedTerms = entries.map((e) => e.correct);
  const verified = verifyRewrite(structured, parsed, {
    allowedTerms,
    speakers: topSpeakers(structured),
    canonicalForms: summarizeGlossary(entries),
  });

  // 引例段确定性回退（见 applyQuotedFallback 注释：不依赖模型遵守提示词）
  const srcById = new Map(structured.map((u) => [u.id, u.text]));
  const fallback = applyQuotedFallback(verified.paragraphs, verified.issues, (id) => srcById.get(id) ?? '');
  verified.paragraphs = fallback.paragraphs;
  if (fallback.repaired.length) {
    console.log(`  引例段回退：${fallback.repaired.length} 段已回退为源发言原文（避免误改示例）`);
  }

  writeJson(path.join(outDir, '05-verified.json'), {
    stats: verified.stats,
    issues: verified.issues,
    parseIssues,
    uncovered: verified.uncovered,
    paragraphs: verified.paragraphs,
  });

  // ⑥ 渲染（只把非 suspect 段落放进正文；suspect 进未决项）
  const main = verified.paragraphs.filter((p) => !p.suspect);
  const blocks = mergeBlocks(main);
  const speakers = topSpeakers(structured);

  // 章节标题：模型产出 → 06-headings.response.json。缺它时先写请求、本轮不插标题。
  // 章节标题键必须**稳定**：用"该块首段的第一个源发言 id"而不是块序号。
  // 实测教训：按块序号做键时，归属修正让块数从 94 变成 81，直接丢掉 4 个标题（15→12）。
  // 用 srcId 做键则重排/合并/拆分都不会失配。
  const headingsFile = path.join(outDir, '06-headings.response.json');
  const blockAnchor = new Map<string, number>();
  blocks.forEach((b, i) => { if (b.srcIds[0]) blockAnchor.set(b.srcIds[0], i); });
  let headings: Map<number, string> | undefined;
  if (fs.existsSync(headingsFile)) {
    const rows = JSON.parse(fs.readFileSync(headingsFile, 'utf-8')) as Array<{ blockIndex?: number; srcId?: string; heading: string }>;
    const picked = new Map<number, string>();
    let unmatched = 0;
    for (const r of rows) {
      const title = String(r.heading ?? '').trim();
      if (!title) continue;
      let index = -1;
      if (r.srcId && blockAnchor.has(r.srcId)) index = blockAnchor.get(r.srcId)!;
      else if (Number.isInteger(r.blockIndex) && blockAnchor.size === 0) index = -1;
      else if (Number.isInteger(r.blockIndex) && (r.blockIndex as number) < blocks.length) {
        // 兼容旧的 blockIndex 格式：把序号映射到该块的锚点，再由锚点落位
        const anchorId = blocks[r.blockIndex as number]?.srcIds[0];
        if (anchorId && blockAnchor.has(anchorId)) index = blockAnchor.get(anchorId)!;
      }
      if (index < 0 || picked.has(index)) { unmatched += 1; continue; }
      picked.set(index, title.slice(0, 24));
    }
    headings = picked;
    console.log(`  章节标题：采用 ${headings.size} 个${unmatched ? `（失配 ${unmatched} 个已丢弃）` : ''}`);
  } else {
    fs.writeFileSync(path.join(outDir, '06-headings.request.md'), [
      '# 任务：为下面每个"发言块"归并出章节主题',
      '',
      '输入是会议清理稿的发言块清单（编号 = blockIndex）。请判断哪些**连续块**在讲同一个主题，',
      '为每个新主题的第一个块给一个短标题。要求：',
      '- 标题 ≤ 12 个汉字；写"主题词"，不要写"第一部分/讨论"这类空话；',
      '- 只输出 JSON 数组，元素形如 {"srcId": "U0100", "heading": "挑战材料与作业归属"}；',
      '- `srcId` 取该块行首方括号里的锚点 id（**不要用块序号**，序号会随重跑变化）；',
      '- 第一个主题必须从清单第一行开始；srcId 必须来自下面的清单；',
      '- 目标 10–18 个章节；不要每个块都给标题。',
      '',
      '## 发言块清单',
      ...blocks.map((b) => `[${b.srcIds[0]}] ${b.speaker}｜${b.from.slice(-8)}—${b.to.slice(-8)}：${b.paragraphs[0].slice(0, 60)}`),
      '',
    ].join('\n'));
    console.log('  章节标题：已生成 06-headings.request.md（本轮产出不含标题，请回包后重跑 assemble）');
  }

  const openItems: string[] = [];
  for (const p of verified.paragraphs.filter((x) => x.suspect)) {
    openItems.push(`〔与原文差异较大，待核〕${p.text.slice(0, 80)}…（源：${p.srcIds.join(',')}）`);
  }
  for (const i of verified.issues.filter((x) => x.reason === 'new_entity')) {
    openItems.push(`〔出现原文没有的写法，待核：${i.detail}〕${i.text.slice(0, 60)}…（源：${i.srcIds.join(',')}）`);
  }
  for (const i of verified.issues.filter((x) => x.reason === 'invalid_anchor')) {
    openItems.push(`〔模型引用了不存在的发言 id，已丢弃该段：${i.detail}〕`);
  }
  if (verified.uncovered.length) {
    openItems.push(`〔有 ${verified.uncovered.length} 条源发言未被任何段落引用（可能被误删）：${verified.uncovered.slice(0, 20).join(',')}〕`);
  }
  for (const e of EXTRA_ENTRIES) {
    openItems.push(`〔本次额外入册，尚未经人工确认〕${e.wrong} → ${e.correct}（${e.note}）`);
  }

  const md = renderMarkdown(blocks, {
    title: '教育智能体演示汇报｜受约束重建版',
    date: '2026-09-05',
    speakers,
    headings,
    glossaryTable: summarizeGlossary(entries).map((g) => ({
      correct: g.correct, forms: g.forms.join('、'), basis: '项目既有文档 + 本次实测入册清单',
    })),
    openItems,
    materials: [
      `原始转写：${readJson(path.join(outDir, '01-source.json')).source}（sha1 ${readJson(path.join(outDir, '01-source.json')).sha1.slice(0, 12)}）`,
      '本项目既有文档：Cogseed 学生版产品故事、Cogseed-Hermes 飞书 MVP 实施计划',
      '词表：transcript_glossary_seed（26 条）+ 本次实测入册 13 条',
    ],
    stats: {
      '源发言条数': verified.stats.sourceCount,
      '输出段落数': verified.paragraphs.length,
      '输出发言块数': blocks.length,
      '字符保留率': `${(verified.stats.retention * 100).toFixed(1)}%（区间 ${'35%–90%'} 内：${verified.stats.retentionOk ? '是' : '否'}）`,
      '锚点覆盖率': `${(verified.stats.anchorCoverage * 100).toFixed(0)}%`,
      '未覆盖源发言': verified.uncovered.length,
      '校验问题数': verified.issues.length,
      '质量门诊断': verified.stats.qualityGate,
      '第三人称转述段数': verified.stats.narrationCount,
      '相似度过低占比': `${(verified.stats.lowSimilarityRatio * 100).toFixed(0)}%`,
    },
  });
  const outFile = path.join(outDir, '清理版.md');
  fs.writeFileSync(outFile, md);
  writeJson(path.join(outDir, 'report.json'), {
    sha1Source: readJson(path.join(outDir, '01-source.json')).sha1,
    stats: verified.stats,
    issues: verified.issues.length,
    uncovered: verified.uncovered.length,
    qualityGate: verified.stats.qualityGate,
    narrationCount: verified.stats.narrationCount,
    lowSimilarityRatio: verified.stats.lowSimilarityRatio,
    blocks: blocks.length,
    paragraphs: verified.paragraphs.length,
    parseIssues: parseIssues.length,
  });
  console.log(`[assemble] ${outFile}`);
  console.log(`  段落 ${verified.paragraphs.length}（正文 ${main.length} / 待核 ${verified.paragraphs.length - main.length}）`);
  console.log(`  发言块 ${blocks.length}；保留率 ${(verified.stats.retention * 100).toFixed(1)}%；锚点覆盖 ${(verified.stats.anchorCoverage * 100).toFixed(0)}%`);
  console.log(`  未覆盖源发言 ${verified.uncovered.length}；校验问题 ${verified.issues.length}`);
  console.log(`  质量门：**${verified.stats.qualityGate}**（第三人称转述 ${verified.stats.narrationCount} 段、`
    + `相似度过低 ${(verified.stats.lowSimilarityRatio * 100).toFixed(0)}%）`);
}

// ── chunkcheck：分块压缩比闸门（多 worker 的方差必须被机械发现）─────────

/**
 * 逐块算压缩比，列出需要重跑的块。
 *
 * 为什么需要这一步（实测教训 2026-09-16）：19 个块分给 5 个 worker 并行处理，
 * 结果 12 个块的压缩比在 75%–99%（等于没做书面化），另外 7 个在 69%–71%。
 * **这是并行 LLM 的固有方差**，靠"写更严的提示词"解决不了——必须靠机械闸门
 * 把越界的块挑出来重跑。本命令就是那个闸门。
 */
async function chunkcheck(args: string[]): Promise<void> {
  const outDir = args[0];
  const min = Number(args[1] ?? 0.45);
  const max = Number(args[2] ?? 0.72);
  if (!outDir) { console.error('chunkcheck 需要 out 目录'); process.exitCode = 1; return; }
  const chunkDir = path.join(outDir, '04-chunks');
  const rows: Array<{ name: string; src: number; out: number; ratio: number }> = [];
  for (const f of fs.readdirSync(chunkDir).filter((x) => x.endsWith('.expected.json')).sort()) {
    const name = f.split('.')[0];
    const expected = readJson(path.join(chunkDir, f));
    const respFile = path.join(chunkDir, `${name}.response.md`);
    if (!fs.existsSync(respFile)) { rows.push({ name, src: expected.chars, out: -1, ratio: -1 }); continue; }
    const body = fs.readFileSync(respFile, 'utf-8');
    const arr = JSON.parse((/\[[\s\S]*\]/.exec(body) ?? ['[]'])[0]) as Array<{ text: string }>;
    const outChars = arr.reduce((n, x) => n + String(x.text ?? '').replace(/\s/g, '').length, 0);
    rows.push({ name, src: expected.chars, out: outChars, ratio: outChars / expected.chars });
  }
  const retry = rows.filter((r) => r.ratio < 0 || r.ratio > max || r.ratio < min);
  console.log(`[chunkcheck] 区间 ${min}–${max}；共 ${rows.length} 块`);
  console.log('  ' + '块    源字符  产出  压缩比');
  for (const r of rows) {
    console.log(`  ${r.name}  ${String(r.src).padStart(6)}  ${String(r.out).padStart(5)}  `
      + (r.ratio < 0 ? '缺失' : `${(r.ratio * 100).toFixed(0)}%`) + (retry.includes(r) ? '  ← 需重跑' : ''));
  }
  const total = rows.reduce((n, r) => n + (r.ratio > 0 ? r.out : 0), 0);
  const totalSrc = rows.reduce((n, r) => n + r.src, 0);
  console.log(`  整体 ${total} / ${totalSrc} = ${((total / totalSrc) * 100).toFixed(1)}%`);
  console.log(`  需重跑：${retry.map((r) => r.name).join(',') || '（无）'}`);
  writeJson(path.join(outDir, '06-chunkcheck.json'), { min, max, rows, retry: retry.map((r) => r.name) });
}

// ── compare ─────────────────────────────────────────────────────────────

async function compare(args: string[]): Promise<void> {
  const [outDir, reference] = args;
  if (!outDir || !reference) { console.error('compare 需要 <out目录> <参考清理版.md>'); process.exitCode = 1; return; }
  const mine = fs.readFileSync(path.join(outDir, '清理版.md'), 'utf-8');
  const ref = fs.readFileSync(reference, 'utf-8');
  // 源文件与 outDir 未必同目录：prepare 会把源目录记进 01-source.json；
  // 旧产物没有该字段时用 --source-dir / 环境变量 / 当前目录兜底（不再硬编码个人路径）。
  const meta = readJson(path.join(outDir, '01-source.json'));
  const sourceDir = meta.sourceDir || process.env.COGSEED_TRANSCRIPT_SOURCE_DIR || process.cwd();
  const sourceText = fs.readFileSync(path.join(sourceDir, meta.source), 'utf-8');
  const rows: Array<[string, string, string]> = [];
  /**
   * 只统计**正文**（去掉「整理附记」段）里的错形残留。
   *
   * 两个必须做对的口径（否则会得出相反的结论）：
   *  ① 附记里的「术语对照表」本来就该列出原始错形（`coxy`、`K star`…），
   *     把它算进来会误判成"没清理干净"；
   *  ② 必须用**词边界**计数：`海运` 是 `刘海运` 的子串、`多维表` 是 `多维表格` 的子串，
   *     朴素子串计数会把正确写法误报成残留（实测因此踩过两次）。
   */
  const bodyOf = (t: string) => t.split('## 整理附记')[0];
  const RESIDUAL_FORMS = [
    'coxy', 'cox', 'coxseed', 'cxxy', 'coxxy', 'coxx', 'coxed', 'cogsed', 'code seat',
    'K star', 'K星', 'kstar', 'k42', 'k32', 'Case2', 'K2', 'K4',
    'IDC', 'IU seed', '雷蒙德', '联盟德', '雷功德', '静文',
    'open cloud', 'cloud code', 'redmi', 'contact', '多 vbl', '多维表',
    '健全', 'personaltology', 'personality', 'roadmap', 'mesh seed', 'mesh c',
  ];
  /**
   * 少数形态必须**区分大小写**计数：`kstar` 与规范形 `KSTAR` 在不区分大小写时是同一个串，
   * 会把**正确**的 22 处 KSTAR 全部误报成残留（实测踩到）。
   * 其余形态仍不区分大小写（`Coxy`/`COXY` 都算错形）。
   */
  const CASE_SENSITIVE_RESIDUALS = new Set(['kstar']);
  const countWord = (t: string, term: string): number => {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flags = CASE_SENSITIVE_RESIDUALS.has(term) ? 'g' : 'gi';
    const re = new RegExp(`(?<![0-9A-Za-z\\u4e00-\\u9fff])${esc}(?![0-9A-Za-z\\u4e00-\\u9fff])`, flags);
    return (t.match(re) ?? []).length;
  };
  const residualIn = (t: string) => RESIDUAL_FORMS
    .map((f) => ({ form: f, count: countWord(t, f) }))
    .filter((x) => x.count > 0);

  const stat = (t: string) => ({
    chars: t.replace(/\s/g, '').length,
    blocks: (t.match(/^\*\*[^*｜]+\｜/gm) ?? []).length,
    headings: (t.match(/^## /gm) ?? []).length,
    notes: (t.match(/〔[^〕]*〕/g) ?? []).length,
    anchors: (t.match(/⟦U\d{4}/g) ?? []).length,
  });
  const srcChars = sourceText.replace(/\s/g, '').length;
  const a = stat(mine); const b = stat(ref);
  rows.push(['非空白字符', String(a.chars), String(b.chars)]);
  rows.push(['字符保留率', `${((a.chars / srcChars) * 100).toFixed(1)}%`, `${((b.chars / srcChars) * 100).toFixed(1)}%`]);
  rows.push(['发言块数', String(a.blocks), String(b.blocks)]);
  rows.push(['章节数(##)', String(a.headings), String(b.headings)]);
  rows.push(['不确定标注数', String(a.notes), String(b.notes)]);
  rows.push(['段落锚点数（可回溯）', String(a.anchors), String(b.anchors)]);
  const latin = (t: string) => (t.match(/[A-Z][A-Za-z]{2,}/g) ?? []).length;
  rows.push(['规范形大写词出现次数', String(latin(mine)), String(latin(ref))]);
  const resMine = residualIn(bodyOf(mine));
  const resRef = residualIn(bodyOf(ref));
  rows.push(['**正文内错形残留（种/处）**',
    `${resMine.length} / ${resMine.reduce((n, x) => n + x.count, 0)}`,
    `${resRef.length} / ${resRef.reduce((n, x) => n + x.count, 0)}`]);
  console.log('\n| 指标 | 本管线产出 | 人工清理版 |');
  console.log('|---|---|---|');
  for (const [k, x, y] of rows) console.log(`| ${k} | ${x} | ${y} |`);
  console.log('\n  正文内错形残留明细（已排除附记对照表、已用词边界）：');
  console.log('    本管线：' + (resMine.length ? resMine.map((x) => `${x.form}×${x.count}`).join('、') : '无'));
  console.log('    人工版：' + (resRef.length ? resRef.map((x) => `${x.form}×${x.count}`).join('、') : '无'));
  fs.writeFileSync(path.join(outDir, 'compare.md'),
    ['| 指标 | 本管线产出 | 人工清理版 |', '|---|---|---|', ...rows.map(([k, x, y]) => `| ${k} | ${x} | ${y} |`)].join('\n') + '\n');
}

// ── 小工具 ──────────────────────────────────────────────────────────────

/**
 * 同一个概念的**中文等价写法**。词表里 `correct` 是英文规范形，但会上人也说中文名
 * （"个人本体""任务智能体"），不过归一化检测若不知道这些等价写法，就会把它们全误报成
 * "过度归一"（实测首轮 26 条告警里有 15 条是这个原因）。这份小表只为**检测**服务，
 * 不参与替换。
 */
const CANONICAL_ALIASES: Record<string, string[]> = {
  'Personal Ontology': ['个人本体', '个人的本体', 'ontology'],
  'Task Agent': ['任务智能体', '任务代理'],
  '多维表格': ['多维表'],
  'KSTAR': ['K star', 'K 星'],
  'EduSeed': ['教育智能体', '教育插件'],
  'Cogseed': ['cox seed', 'coxed'],
};

function summarizeGlossary(entries: GlossaryEntry[]): Array<{ correct: string; forms: string[] }> {
  const map = new Map<string, string[]>();
  for (const e of entries) {
    const list = map.get(e.correct) ?? [];
    list.push(e.wrong);
    map.set(e.correct, list);
  }
  for (const [correct, extra] of Object.entries(CANONICAL_ALIASES)) {
    const list = map.get(correct);
    if (list) list.push(...extra);
  }
  return [...map.entries()].map(([correct, forms]) => ({ correct, forms }));
}

function speakerList(u: Utterance[]): string {
  return topSpeakers(u).join('、');
}

function topSpeakers(u: Utterance[]): string[] {
  const count = new Map<string, number>();
  for (const x of u) count.set(x.speaker, (count.get(x.speaker) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function writeJson(file: string, data: unknown): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}
