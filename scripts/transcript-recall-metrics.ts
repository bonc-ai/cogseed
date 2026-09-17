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
      for (const name of fs.readdirSync(abs)) {
        if (name.toLowerCase().endsWith('.txt') && !name.includes('清理版')) files.push(path.join(abs, name));
      }
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
    MeshSeed: { canonical: 'MeshSeed', variants: ['mesh seed', 'mesh c'] },
    README: { canonical: 'README', variants: ['redmi'] },
    Moodle: { canonical: 'Moodle', variants: ['model'] },
    Context: { canonical: 'Context', variants: ['contact'] },
    鉴权: { canonical: '鉴权', variants: ['健全'] },
    多维表格: { canonical: '多维表格', variants: ['多 vbl', '多维表'] },
    Richard: { canonical: 'Richard', variants: ['瑞昌', '理查德', '非常老师', '这常老师', '日超', '胡老师', '瑞嘉'] },
    静雯: { canonical: '静雯', variants: ['静文'] },
  };

  /** 域内概念：本次样本里真实讨论过的概念（模拟"从本体/会议主题拿到域先验"）。 */
  const domainTerms: string[] = [];
  for (const { canonical } of Object.values(GOLD)) {
    if (docs.some((d) => d.text.toLowerCase().includes(canonical.toLowerCase()))) domainTerms.push(canonical);
  }
  console.log(`域内概念（由样本正文自动推定）：${domainTerms.join('、')}\n`);

  // ── 逐份文档跑两条通道 ─────────────────────────────────────────────
  const literalCoveredVariants = new Set<string>();
  const recalledVariants = new Set<string>();
  const channels = { normalized: 0, phonetic: 0, edit: 0, weak: 0 };
  const disposition = { suggest: 0, review: 0 };
  const allCandidateSurfaces = new Set<string>();
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
      allCandidateSurfaces.add(normalizeKey(c.wrong));
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

  const WHY = {
    需拼音表: [] as string[],
    相似度不足只能入册: [] as string[],
    阈值或守卫拦下需排查: [] as string[],
  };
  for (const [v] of missedForms) {
    const canonical = variantCanonical.get(v) ?? '';
    const kSim = similarity(normalizeKey(v), normalizeKey(canonical));
    const hasCjk = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(v);
    if (hasCjk && hasCjk && kSim < 0.9) WHY.需拼音表.push(v);
    else if (Math.max(kSim, similarity(phoneticKey(v), phoneticKey(canonical))) >= 0.65) WHY.阈值或守卫拦下需排查.push(v);
    else WHY.相似度不足只能入册.push(v);
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
  const unexpectedSuggestions = [...allCandidateSurfaces].filter((s) => !goldKeys.has(s));
  console.log(`  潜在误推荐（suggest 但不在 gold 清单的形态）：${unexpectedSuggestions.length}`
    + (unexpectedSuggestions.length ? ` → ${unexpectedSuggestions.slice(0, 20).join(', ')}` : ''));

  // ── 表④ 建议入册清单 ─────────────────────────────────────────────
  console.log('\n表④ residual 高频形态 TOP 20（"必须入册或靠域先验"的行动清单候选；需人工确认后入册）');
  const topResidual = [...residuals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  for (const [surface, count] of topResidual) console.log(`  ${pad(surface, 24)} ×${count}`);

  console.log('\n[metrics] 完成（只读；未写入任何文件）\n');
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
