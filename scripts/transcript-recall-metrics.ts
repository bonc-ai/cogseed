#!/usr/bin/env npx tsx
/**
 * transcript-recall-metrics — 用**真实转写**度量召回层的实际收益（只读，不写任何文件）
 *
 * 为什么必须有一个独立的度量脚本：
 *   在此之前"纠错率"一直是主观判断（复核文档自己写了"无 UsageReceipt → 命中率只能自测"）。
 *   本项目的第一条结论就是 **L0 评测优先**：先把数字拿到，再改组件；否则改完不知道
 *   是召回涨了还是误替换涨了。
 *
 * 用法：
 *   npx tsx scripts/transcript-recall-metrics.ts <文件或目录> [更多路径…]
 *   npx tsx scripts/transcript-recall-metrics.ts ~/Desktop/文字转写
 *
 * 输出四张表：
 *   ① 逐概念的召回覆盖率（字面词表 vs +多路召回）—— 含"仍未召回"的具体形态
 *   ② 未召回形态的**原因归类**（可字面/可音形/只能入册/需拼音/需域先验）
 *   ③ 候选分级分布（suggest / review）与 byChannel
 *   ④ 建议入册清单（由实测形态生成，供人工确认后作为词条）
 *
 * 设计原则：**只报告事实，不给建议映射**。本脚本不猜"某个形态应该改成什么"，
 * 只把"字面词表兜住了哪些、召回层补上了哪些、还剩哪些"摆出来。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// paths.ts 在导入时就要求工作区根目录；脚本不能真的写用户数据，故指向一个临时目录。
// （必须在**任何** src/main 模块导入之前设置，因此下面全部用动态 import。）
process.env.COGSEED_WORKSPACE_ROOT = process.env.COGSEED_WORKSPACE_ROOT
  || fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-recall-metrics-'));

main().catch((err) => {
  console.error('[metrics] 失败：', err);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const { INITIAL_GLOSSARY_SEED } = await import('../src/main/features/transcript_glossary_seed');
  const { defaultBoundary } = await import('../src/main/features/transcript_glossary');
  const { normalizeKey, phoneticKey, recallCandidates, similarity } = await import('../src/main/features/transcript_recall');
  const { scanText } = await import('../src/main/features/transcript_auto_correct');
  type GlossaryEntry = import('../src/main/features/transcript_glossary').GlossaryEntry;

  // ── 输入：文件或目录 ────────────────────────────────────────────────
  const inputs = process.argv.slice(2);
  if (!inputs.length) {
    console.error('用法: npx tsx scripts/transcript-recall-metrics.ts <文件或目录> [更多路径…]');
    process.exitCode = 1;
    return;
  }
  const files: string[] = [];
  for (const input of inputs) {
    const abs = path.resolve(input);
    if (!fs.existsSync(abs)) { console.warn(`[metrics] 跳过不存在的路径：${abs}`); continue; }
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      files.push(...walkTxt(abs));
    } else {
      files.push(abs);
    }
  }
  if (!files.length) { console.error('[metrics] 没有可用的 .txt 转写文件'); process.exitCode = 1; return; }

  // 去重（同一份转写可能被复制多份；重复计入会把比例算歪）
  const seen = new Set<string>();
  const docs: Array<{ name: string; text: string }> = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf-8');
    if (!text.includes('会议已开启实时转写') && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/m.test(text)) continue;
    const hash = normalizeKey(text).slice(0, 64) + ':' + text.length;
    if (seen.has(hash)) continue;
    seen.add(hash);
    docs.push({ name: path.basename(f), text });
  }
  if (!docs.length) { console.error('[metrics] 没有识别到转写文件（需含"会议已开启实时转写"或时间戳行）'); process.exitCode = 1; return; }

  const corpusChars = docs.reduce((n, d) => n + d.text.replace(/\s/g, '').length, 0);
  console.log(`\n样本：${docs.length} 份去重转写 / ${corpusChars.toLocaleString()} 非空白字符`);
  for (const d of docs) console.log(`  · ${d.name}`);

  // ── 词表：项目真实种子 ─────────────────────────────────────────────
  let seq = 0;
  const entries: GlossaryEntry[] = INITIAL_GLOSSARY_SEED.map((row) => {
    seq += 1;
    return {
      id: `seed_${seq}`,
      wrong: row.wrong,
      correct: row.correct,
      action: 'replace' as const,
      kind: row.kind,
      riskLevel: row.riskLevel,
      boundary: defaultBoundary(row.wrong, 'replace'),
      contextDeny: [],
      contextAllow: [],
      scope: { docIds: [], scenarioTags: [], global: true },
      freq: 0,
      source: 'manual' as const,
      status: 'active' as const,
      ownerScope: 'personal' as const,
      replacedIn: [],
      createdBy: 'manual' as const,
      createdAt: 1,
      updatedAt: 1,
      lastVerifiedAt: 1,
    };
  });
  console.log(`词表：种子 ${entries.length} 条（${new Set(entries.map((e) => e.correct)).size} 个概念）`);

  // ── gold：真实错形 → 规范形（来自两份人工清理版附记的实测分布）──────
  const GOLD: Record<string, { canonical: string; variants: string[] }> = {
    Cogseed: { canonical: 'Cogseed', variants: ['coxy', 'cox', 'coxs', 'coxseed', 'cogsed', 'CXXY', 'COS', 'coco', 'coke', 'code seat', 'coc', 'coxxy', 'coxx', 'coxed'] },
    KSTAR: { canonical: 'KSTAR', variants: ['K star', 'K星', 'k42', 'k32', 'K4', 'Case2', 'K2', 'kstar'] },
    EduSeed: { canonical: 'EduSeed', variants: ['IDC', 'IU seed'] },
    Raymond: { canonical: 'Raymond', variants: ['雷蒙德', '雷功德', '联盟德', 'roadmap'] },
    'Personal Ontology': { canonical: 'Personal Ontology', variants: ['personal ontology', 'personaltology', 'personality', 'personalontology'] },
    OpenClaw: { canonical: 'OpenClaw', variants: ['open cloud', '开放云'] },
    'Claude Code': { canonical: 'Claude Code', variants: ['cloud code', '云代码'] },
    CogSeed: { canonical: 'CogSeed', variants: ['mesh seed', 'mesh c'] },
    README: { canonical: 'README', variants: ['redmi'] },
    Moodle: { canonical: 'Moodle', variants: ['model'] },
    Context: { canonical: 'Context', variants: ['contact'] },
    鉴权: { canonical: '鉴权', variants: ['健全'] },
    多维表格: { canonical: '多维表格', variants: ['多 vbl', '多维表'] },
    ExampleSpeaker: { canonical: 'ExampleSpeaker', variants: ['示例讲者', '样例讲师', '示例老师甲', '示例老师乙', '样例甲', '样例乙', '示例嘉'] },
    ExamplePerson: { canonical: 'ExamplePerson', variants: ['示例人'] },
  };

  /**
   * 域内概念：本次样本里真实讨论过的概念（模拟"从本体/会议主题拿到域先验"）。
   * 判据必须是"规范形**或其任一已知错形**出现"——规范形本身常常在正文里一次都不出现
   * （实测：Cogseed 在原文里 0 次，全是 coxy/cox 等形态），只查规范形会把域判空。
   */
  const domainTerms: string[] = [];
  for (const { canonical, variants } of Object.values(GOLD)) {
    const hay = docs.map((d) => d.text.toLowerCase()).join('\n');
    if (hay.includes(canonical.toLowerCase()) || variants.some((v) => hay.includes(v.toLowerCase()))) {
      domainTerms.push(canonical);
    }
  }
  console.log(`域内概念（由样本正文自动推定）：${domainTerms.join('、')}\n`);

  // ── 逐份文档跑两条通道 ─────────────────────────────────────────────
  const literalCoveredVariants = new Set<string>();
  const recalledVariants = new Set<string>();
  const channels = { normalized: 0, phonetic: 0, edit: 0, weak: 0 };
  const disposition = { suggest: 0, review: 0 };
  const suggestedSurfaces = new Map<string, string>();
  const byVariant = new Map<string, { literal: number; recall: number; total: number }>();
  const residuals = new Map<string, number>();
  let literalCandidateTotal = 0;
  let recallCandidateTotal = 0;

  for (const doc of docs) {
    // 字面通道（现有生产实现）
    const literal = scanText(doc.text, entries);
    literalCandidateTotal += literal.candidates.length;
    for (const c of literal.candidates) literalCoveredVariants.add(normalizeKey(c.wrong));

    // 多路召回层
    const rec = recallCandidates(doc.text, entries, { domainTerms });
    recallCandidateTotal += rec.candidates.length;
    for (const c of rec.candidates) {
      recalledVariants.add(normalizeKey(c.wrong));
      if (c.disposition === 'suggest') {
        suggestedSurfaces.set(
          normalizeKey(c.wrong),
          `${c.wrong} → ${c.correct}［命中词条 "  ${c.matchedWrong}  "］（${c.channel} ${c.similarity.toFixed(2)}）`,
        );
      }
      channels[c.channel] += 1;
      disposition[c.disposition] += 1;
    }
    for (const r of rec.stats.residual) residuals.set(r.surface, (residuals.get(r.surface) ?? 0) + r.count);
  }

  // 逐形态统计出现次数
  const corpus = docs.map((d) => d.text).join('\n');
  for (const [concept, { variants }] of Object.entries(GOLD)) {
    for (const v of variants) {
      const count = countOccurrences(corpus, v);
      if (!count) continue;
      byVariant.set(`${concept}\t${v}`, {
        total: count,
        literal: literalCoveredVariants.has(normalizeKey(v)) ? count : 0,
        recall: recalledVariants.has(normalizeKey(v)) ? count : 0,
      });
    }
  }

  // ── 表① 逐概念覆盖率 ───────────────────────────────────────────────
  const conceptRows: Array<{ concept: string; total: number; literal: number; recall: number; missed: Array<[string, number]> }> = [];
  for (const [concept, { variants }] of Object.entries(GOLD)) {
    let total = 0; let lit = 0; let rec = 0;
    const missed: Array<[string, number]> = [];
    for (const v of variants) {
      const row = byVariant.get(`${concept}\t${v}`);
      if (!row) continue;
      total += row.total; lit += row.literal; rec += row.recall;
      if (!row.recall) missed.push([v, row.total]);
    }
    if (!total) continue;
    conceptRows.push({ concept, total, literal: lit, recall: rec, missed: missed.sort((a, b) => b[1] - a[1]) });
  }
  conceptRows.sort((a, b) => b.total - a.total);

  const sumTotal = conceptRows.reduce((n, r) => n + r.total, 0);
  const sumLiteral = conceptRows.reduce((n, r) => n + r.literal, 0);
  const sumRecall = conceptRows.reduce((n, r) => n + r.recall, 0);

  console.log('表① 逐概念召回覆盖率（真实转写，含全套已知错形）');
  console.log('  ' + pad('概念', 20) + pad('错形数', 8) + pad('字面词表', 10) + pad('字面%', 8) + pad('+多路召回', 10) + pad('召回%', 8) + '仍未召回形态');
  for (const r of conceptRows) {
    console.log('  ' + pad(r.concept, 20) + pad(String(r.total), 8) + pad(String(r.literal), 10)
      + pad(pct(r.literal, r.total), 8) + pad(String(r.recall), 10) + pad(pct(r.recall, r.total), 8)
      + r.missed.map(([v, n]) => `${v}×${n}`).join(', '));
  }
  console.log('  ' + '-'.repeat(110));
  console.log('  ' + pad('合计', 20) + pad(String(sumTotal), 8) + pad(String(sumLiteral), 10)
    + pad(pct(sumLiteral, sumTotal), 8) + pad(String(sumRecall), 10) + pad(pct(sumRecall, sumTotal), 8));

  // ── 表② 未召回原因归类 ────────────────────────────────────────────
  /** 形态 → 所属概念的规范形（用于判断"相似度够不够"）。 */
  const variantCanonical = new Map<string, string>();
  for (const { canonical, variants } of Object.values(GOLD)) {
    for (const v of variants) variantCanonical.set(v, canonical);
  }
  const missedForms = new Map<string, number>();
  for (const r of conceptRows) for (const [v, n] of r.missed) missedForms.set(v, n);

  /** 概念 → 该概念在词表里的全部错形键（用于判断"相似度够不够"）。 */
  const entryKeysByCanonical = new Map<string, string[]>();
  for (const e of entries) {
    const list = entryKeysByCanonical.get(normalizeKey(e.correct)) ?? [];
    list.push(normalizeKey(e.wrong));
    entryKeysByCanonical.set(normalizeKey(e.correct), list);
  }
  const WHY: Record<string, string[]> = {
    '词表缺条目（只能先入册）': [],
    '需拼音表（中文音近）': [],
    '相似度不足（只能入册或域先验）': [],
    '阈值或守卫拦下（需排查）': [],
  };
  for (const [v] of missedForms) {
    const canonical = variantCanonical.get(v) ?? '';
    const keys = entryKeysByCanonical.get(normalizeKey(canonical));
    if (!keys || !keys.length) { WHY['词表缺条目（只能先入册）'].push(v); continue; }
    const vKey = normalizeKey(v);
    const vSkel = phoneticKey(v);
    let best = 0;
    for (const k of keys) best = Math.max(best, similarity(vKey, k), similarity(vSkel, phoneticKey(k)));
    const hasCjk = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(v);
    if (hasCjk && best < 0.9) WHY['需拼音表（中文音近）'].push(v);
    else if (best < 0.65) WHY['相似度不足（只能入册或域先验）'].push(v);
    else WHY['阈值或守卫拦下（需排查）'].push(v);
  }
  console.log('\n表② 仍未召回的形态 —— 按"为什么没召回"归类（本层只报告，不给建议映射）');
  const missedTotal = [...missedForms.values()].reduce((a, b) => a + b, 0);
  for (const [k, list] of Object.entries(WHY)) {
    if (!list.length) continue;
    console.log(`  ${k}（${list.length} 种）：` + list.map((v) => `${v}×${missedForms.get(v)}`).join(', '));
  }
  console.log(`  合计未召回 ${missedForms.size} 种 / ${missedTotal} 处（占总错形 ${pct(missedTotal, sumTotal)}）`);
  console.log('  说明：中文形态缺的是拼音表（零依赖下未内置，见 transcript_recall 头注）；');
  console.log('        "相似度不足"的形态（如 roadmap→Raymond、k42 之外的纯异形）只能靠入册或域先验。');

  // ── 表③ 候选分级与通道分布 ────────────────────────────────────────
  console.log('\n表③ 候选分级与通道分布（多路召回层，全部为候选、不自动替换）');
  console.log(`  候选总数 ${recallCandidateTotal}（字面通道另有 ${literalCandidateTotal} 条）`);
  console.log(`  byChannel：` + Object.entries(channels).map(([k, v]) => `${k}=${v}`).join('  '));
  console.log(`  分级：suggest=${disposition.suggest}（可提为建议，仍须确认）  review=${disposition.review}（必须人工判断）`);

  // 精度代理：被判为 suggest、但不在 gold 错形清单里的形态 = 潜在误推荐
  const goldKeys = new Set<string>();
  for (const { variants } of Object.values(GOLD)) for (const v of variants) goldKeys.add(normalizeKey(v));
  // 精度代理：被判为 suggest、但形态不在 gold 错形清单里的候选 = 需要逐条核对的"新形态"。
  //
  // ⚠️ 这一节**不是误替换计数**。首轮跑出来的 10 条经逐条读上下文核对，**全部是真实变体**
  // （证据见脚本下方 EXTRA_VERIFIED 的引文），说明"不在 gold 里"只代表 gold 不全，
  // 不代表模型错了。真精度必须靠人工标注的 gold 集，故此处只负责把"该看的东西"摆出来。
  const unexpected = [...suggestedSurfaces.entries()].filter(([k]) => !goldKeys.has(k));
  console.log(`  不在 gold 清单的 suggest 候选：${unexpected.length} 条（需逐条核对；见 EXTRA_VERIFIED 已验证结论）`);
  let verified = 0;
  for (const [key, detail] of unexpected.slice(0, 20)) {
    const note = EXTRA_VERIFIED[key] ? '  ← 已核对：真实变体' : '  ← 待核对';
    if (EXTRA_VERIFIED[key]) verified += 1;
    console.log(`    · ${detail}${note}`);
  }
  console.log(`    其中已人工核对为真实变体的：${verified}/${unexpected.length}`
    + `（引文见 scripts/transcript-recall-metrics.ts 的 EXTRA_VERIFIED）`);

  // ── 表④ 建议入册清单 ─────────────────────────────────────────────
  console.log(`\n表④ 建议入册清单（由表① 未召回形态生成；**入册需人工确认**，本脚本不自动改词表）`);
  const needEntry: Array<{ concept: string; form: string; count: number; why: string }> = [];
  for (const [v, n] of missedForms) {
    const concept = variantCanonical.get(v) ?? '';
    let why = '需入册';
    for (const [label, list] of Object.entries(WHY)) if (list.includes(v)) why = label;
    needEntry.push({ concept, form: v, count: n, why });
  }
  needEntry.sort((a, b) => b.count - a.count);
  for (const r of needEntry) console.log(`  ${pad(r.concept, 20)} ${pad(r.form, 16)} ×${r.count}  ${r.why}`);
  console.log(`  合计 ${needEntry.length} 种 / ${needEntry.reduce((a, b) => a + b.count, 0)} 处`);
  console.log(`  （residual 原始清单另有 ${residuals.size} 种"不属于任何词条 correct 形态"的串，`
    + `但其中混有正常词汇——判定哪些是真错形需要词典，本脚本不做这一猜测。）`);

  console.log('\n[metrics] 完成（只读；未写入任何文件）\n');
}

/**
 * 首轮"不在 gold 清单的 suggest 候选"的**逐条上下文核对结果**。
 *
 * 结论：全部 10 条都是**真实变体**，不是误替换。之所以要写在这里，是因为
 * 该判断只能靠读原文上下文得出，必须让证据跟着代码走、可被复核。
 * 这也直接说明了为什么"字面/音形相似度"类的启发式护栏要慎加——
 * 我曾基于"这些都是误推荐"的错误判断加过一道音形字面地板，撤回。
 */
// 键 = normalizeKey(形态)（去空格、小写），与查表口径一致。
const EXTRA_VERIFIED: Record<string, string> = {
  'carseat': '「咱们 cox seed 是一个是你的个人的大管家…这同一个 car seat 它可以对后面无数个不同的 task agent」→ 指 Cogseed',
  'cockseed': '「你的这个 cock seed 的话，实际上是针对的是一个个人的角度来说」→ 指 Cogseed',
  'coseat': '「我在我的 coseat 里面，我说一个提交」→ 指 Cogseed',
  'codeset': '「当我在用 codeset 的过程中，比如说触发了一些假设」→ 指 Cogseed',
  'cocet': '「我可以让我的 codex 让 cocet 也能生成插麦的图」→ 指 Cogseed',
  'cocket': '「咱俩的 cocket 都是我们的 AI 工具之间去沟通」→ 指 Cogseed',
  'personalcollege': '「我的 personal college 只要有这东西的话，我自动的给你填了」→ 指 Personal Ontology',
  'personalquality': '「我觉得就是 personal quality 的话，其实按理说也应该是自己在」→ 指 Personal Ontology',
  'personalholiday': '「What is in my personal holiday?」→ 上下文在讲 Personal Ontology',
  'openclaw': '「大家经常提 OpenClaw、Claude Code 这些词」→ 本身就是正确写法，属大小写归一',
  'personaloncology': '「如果是就是怎么说呢？人力资源管理啊，或者说 personal oncology 啊」→ 同句列举的都是资产/权限类概念，指 Personal Ontology',
};

/** 递归收集目录下的 .txt 转写（会议目录是多层嵌套的）。 */
function walkTxt(dir: string, depth = 0): string[] {
  if (depth > 4) return [];
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    let st: fs.Stats;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) out.push(...walkTxt(full, depth + 1));
    else if (name.toLowerCase().endsWith('.txt') && !name.includes('清理版')) out.push(full);
  }
  return out;
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  const folded = text.toLowerCase();
  const target = needle.toLowerCase();
  let from = 0; let n = 0;
  for (;;) {
    const at = folded.indexOf(target, from);
    if (at < 0) return n;
    // ASCII 形态要求"词边界"，避免 cox 命中 coxy 内部造成重复计数
    if (/^[A-Za-z]/.test(needle)) {
      const before = text[at - 1]; const after = text[at + needle.length];
      if ((before && /[0-9A-Za-z]/.test(before)) || (after && /[0-9A-Za-z]/.test(after))) { from = at + 1; continue; }
    }
    n += 1;
    from = at + needle.length;
  }
}

function pad(s: string, width: number): string {
  // 中文按 2 列宽估算，保证表格在等宽终端里对齐
  let w = 0;
  for (const ch of s) w += /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(1, width - w));
}

function pct(part: number, whole: number): string {
  if (!whole) return '—';
  return `${Math.round((part / whole) * 100)}%`;
}
