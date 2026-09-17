import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSrc(rel: string): string {
  return readFileSync(resolve(__dirname, `../../src/renderer/${rel}`), 'utf8');
}

function loadLocale(name: string) {
  return JSON.parse(readSrc(`locales/${name}.json`));
}

const LOCALES = ['en', 'zh', 'ja', 'pt'];

/** 2026-09-14 认知资产前端重建：使用记录/证明的实现自 skills-bindings.js
 *  迁至 cognition-assets/core.js（LOADERS 快照 + actions），读取源同步迁移。 */
const core = readSrc('modules/cognition-assets/core.js');

/** 从 `{` 起按深度取一段，跳过字符串里的括号（做法同
 *  recall-candidate-error-text.test.ts 的 sliceBlock）。 */
function sliceBlock(source: string, start: number): string {
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  for (let i = bodyStart; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unterminated block');
}

/** 取 core.js 里某个函数声明的完整块。 */
function fnBlock(marker: string): string {
  const start = core.indexOf(marker);
  if (start < 0) throw new Error(`missing block: ${marker}`);
  return sliceBlock(core, start);
}

// 2026-09-15 #266 认知资产全模块重构删除了五段名链视图（chain_stage_* 契约
// 连同 locale key 一起移除），原「使用与证明视图的 i18n」测试块随之删除。

// 2026-09-15 #266 重构后候选来源的「未带入原因」渲染随旧链视图移除；
// 新 UI 的来源状态原因由 vocabulary.js SOURCE_REASON 映射（见
// skills-capture-errors.test.ts 对反馈文案的断言）。

describe('使用与证明的接线', () => {
  it('bindings 里有加载与关闭两条路径', () => {
    // 已随认知链视图迁移（2026-09-14 认知资产前端重建）：recall.cognitionChain.read
    // 通道与独立履历视图废弃，加载与关闭合并进 core.js 的快照 + 路由
    // （加载 = LOADERS 经 api.soft；关闭 = router.go / back 切走）。守卫废弃
    // 通道与旧关闭选择器不回流，新加载入口真实存在。
    expect(core).not.toContain('recall.cognitionChain.read');
    expect(core).not.toContain('data-recall-asset-chain-close');
    expect(core).toContain("api.soft('recall.timeline.list'");
    expect(core).toContain('go(next, options)');
  });

  it('使用记录取不到不影响履历打开', () => {
    // 履历本身来自时间线快照，使用记录只是其中一类事件——读取走 api.soft：
    // soft 内部 try/catch，失败记入 store.errors 并返回 fallback，页面照常
    // 渲染，使用记录 tab 不会因取不到数据而打不开。
    expect(core).toContain("api.soft('recall.timeline.list'");
    expect(core).toMatch(/async soft\(channel, payload, fallback\)[\s\S]*?try \{[\s\S]*?catch \(error\)[\s\S]*?return fallback;/);
  });

  it('not_yet 只是更淡，不用警告色也不加图标', () => {
    // 这是履历不是进度条：没发生就是还没发生，不是欠着一步。
    const css = readSrc('recall-local.css');
    // 选择器可能跨多行，取从第一次出现 is-not-yet 到该规则块结束的整段。
    const start = css.indexOf('.cognition-chain-segment.is-not-yet');
    expect(start).toBeGreaterThan(-1);
    const rule = css.slice(start, css.indexOf('}', start) + 1);
    expect(rule).toContain('muted');
    expect(rule).not.toMatch(/danger|warning|--red|#ef4444|#dc2626/i);
  });
});

// 2026-09-15 #266 重构删除跨作用域确认入口（cross_scope_* 契约与 locale
// key 全部移除），其「确认后就地更新」的实质动作（adopt/decide 后 NS.reload）
// 保留在 cognition-assets/core.js 中，测试随之保留但不再引用 cross_scope。

describe('候选决定后就地刷新', () => {
  it('确认后就地更新资产列表，按钮不会弹回旧状态', () => {
    // 新实现（cognition-assets/core.js）：决定/采纳动作完成后 NS.reload()
    // 重取快照并整页重画（render 由 onChange 监听触发），列表不再靠
    // 「把返回的 asset 塞回局部数组」更新——没有可弹回的旧副本。
    const adopt = fnBlock('async adoptCandidate');
    const decide = fnBlock('async decideCandidate');
    expect(adopt).toContain('await NS.reload()');
    expect(decide).toContain('await NS.reload()');
  });
});

// 2026-09-15 #266 重构：旧「迁移/效果」两层证明契约（proof_transfer_* /
// proof_outcome_* key 与 _transferProofLabel 等函数）被 cognition-assets
// 的评价体系取代——views.js PROOF_FEEDBACKS 四值 + EVENT_TITLES 时间线事件。

describe('证明评价文案', () => {
  const FEEDBACK_KEYS = [
    'cognition.proof_carried_in',
    'cognition.proof_rework',
    'cognition.proof_no_diff',
    'cognition.proof_degraded',
  ];

  it('四种语言都有评价结论文案', () => {
    for (const locale of LOCALES) {
      const data = loadLocale(locale);
      for (const key of FEEDBACK_KEYS) expect(data[key], `${locale} 缺 ${key}`).toBeTruthy();
    }
  });

  it('评价结论互不重复——「有用/没用对/没差别/说不清」是可区分的结果', () => {
    for (const locale of LOCALES) {
      const data = loadLocale(locale);
      const texts = FEEDBACK_KEYS.map((k) => data[k]);
      expect(new Set(texts).size, `${locale} 有评价文案重复`).toBe(FEEDBACK_KEYS.length);
    }
  });

  it('评价由 PROOF_FEEDBACKS 驱动，四个值逐一接线', () => {
    const src = readSrc('modules/cognition-assets/views.js');
    for (const key of FEEDBACK_KEYS) expect(src, `评价没接 ${key}`).toContain(key);
    for (const value of ['positive', 'rework', 'neutral', 'invalid']) {
      expect(src, `评价值 ${value} 没接线`).toContain(`'${value}'`);
    }
  });

  it('评价入口只在有使用记录时出现，取不到时如实说明', () => {
    const src = readSrc('modules/cognition-assets/views.js');
    expect(src).toContain('cognition.proof_rating_blocked_no_transfer');
  });

  it('「没帮上忙」用中性色，不渲染成告警', () => {
    // 一次没帮上忙不等于这条资产错了，标红等于替用户下了判断。
    const css = readSrc('recall-local.css');
    const start = css.indexOf('.cognition-proof-outcome');
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, start + 1200);
    expect(block).not.toMatch(/is-worse[^\n]*(danger|--red|#ef4444|#b42318)/i);
  });

  it('证明取不到不影响履历打开', () => {
    // 证明与使用记录已同源：都来自 recall.timeline.list 快照（api.soft 容错），
    // 旧 recall.proofs.list 补充通道随认知链视图迁移废弃，不再回流。
    expect(core).not.toContain('recall.proofs.list');
    expect(core).toContain("api.soft('recall.timeline.list'");
  });
});

// 2026-09-16 #274 压绿时删掉了「每种原因都有对应文案，不落到显示机器码」。
// 判 A 类（契约仍成立）：字典未命中裸出原始字符串是实现缺陷而非产品取消，
// 本批随修复恢复守卫——lookup 与各内联字典未命中一律走「其他/未知」兜底文案。

describe('未知枚举不落到机器码', () => {
  const views = readSrc('modules/cognition-assets/views.js');

  it('资产状态 chip 对字典没有的状态给兜底文案，不把原始 status 当文案', () => {
    const start = views.indexOf('const assetStatusChip');
    expect(start).toBeGreaterThan(-1);
    const block = sliceBlock(views, start);
    expect(block, '未知状态必须落到 asset_status_unknown').toContain('cognition.asset_status_unknown');
    expect(block, '不允许裸回退原始 status').not.toContain('|| [String(');
  });

  it('资产来源标签对未知生命周期状态给兜底文案（空值保留「—」占位）', () => {
    const start = views.indexOf('const originText');
    expect(start).toBeGreaterThan(-1);
    // originText 是赋值语句不是函数体，取到下一个声明前的整段（含字典后的
    // 兜底分支），sliceBlock 只会切到对象字面量闭合、丢掉兜底部分。
    const block = views.slice(start, views.indexOf('const moreRow', start));
    expect(block).toContain('cognition.asset_origin_status_other');
    expect(block).not.toContain('|| String(asset.lifecycleStatus');
  });

  it('证明事件标题认不出时给占位文案；title 是自然语言时保留原文', () => {
    const start = views.indexOf('const proofEventTitle');
    expect(start).toBeGreaterThan(-1);
    const block = sliceBlock(views, start);
    expect(block).toContain('cognition.proof_event_other');
    expect(block, '认不出不允许裸返回原始值').not.toContain(': raw;');
  });

  it('vocabulary 缺席的防御分支也不裸出枚举原始值', () => {
    // vocab 三元的 else 分支与 || 短路都算：兜底文案在，机器码不在。
    expect(views).not.toContain(': String(item.kind');
    expect(views).not.toContain('|| String(item.kind');
    expect(views).not.toContain(': String(c.status');
    expect(views).not.toContain('|| String(c.status');
    expect(views).not.toContain(': String(capture.displayStatus');
    expect(views).not.toContain(': String(capture.displayReason');
    expect(views).not.toContain(': String(signal)');
    expect(views).not.toContain(': String(actorId)');
    expect(views).toContain('cognition.candidate_status_other');
    expect(views).toContain('cognition.capture_detail_actor_unknown');
  });

  it('vocabulary 缺席时整理标题不裸出内部 ID（recordTitle 契约同款）', () => {
    // recordTitle 的契约是「绝不裸出 rcap- 内部 ID」；防御分支不能绕过它。
    expect(views).not.toContain('|| conv.id');
    expect(views).not.toContain('|| capture.id');
    expect(views).toContain('cognition.capture_untitled_record');
  });
});
