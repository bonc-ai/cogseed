/**
 * 知识库前端 i18n 键完备性（跨模块）
 *
 * 背景：`_t/_tr/t(key, '中文回退')` 的**缺键是静默的** —— 找不到键就回退中文，
 * 界面不会报错，只在切到 en/ja/pt 时露馅。此前只有 kb-workbench 自带一条键覆盖断言，
 * 其余模块（尤其本轮刚 key 化完的）没有任何守卫。
 *
 * 这条测试扫全部 `kb-*.js`：
 *   1. 代码里用到的每个 `kb.*` 键、以及每个 `data-*-text/title/label/placeholder/aria` 钩子键，
 *      都必须在 **4 份 locale** 里存在；
 *   2. zh 的值必须与代码里写的中文回退**逐字一致**（两边不一致时，"缺键回退"与"正常取值"
 *      会给出两种文案，用户在切语言时会看到突然的措辞变化）；
 *   3. 顺带守住"钩子只承载静态文案"：钩子的值必须长得像键，不允许是运行时表达式
 *      （`${open ? 'a' : 'b'}` 这种会在切语言时把状态文案刷回初始值 —— 已踩过一次）。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');
const modulesDir = path.join(root, 'src/renderer/modules');
const locales = ['zh', 'en', 'ja', 'pt'] as const;

const moduleFiles = fs.readdirSync(modulesDir).filter((f) => /^kb-.*\.js$/.test(f)).sort();
const dicts = Object.fromEntries(locales.map((l) => [
  l,
  JSON.parse(fs.readFileSync(path.join(root, `src/renderer/locales/${l}.json`), 'utf8')) as Record<string, string>,
]));

/** 代码里用到的键（`t(…)` / `_t(…)` / `_tr(…)`，键名一定是 kb. 开头） */
function usedKeys(source: string): string[] {
  const out = new Set<string>();
  const re = /\b_?tr?\(\s*'(kb\.[a-zA-Z0-9_.]+)'/g;
  for (const m of source.matchAll(re)) {
    // 以 _ 结尾的是**运行时拼接的前缀**（'kb.x.denied_reason_' + reason），不是真键
    if (m[1].endsWith('_')) continue;
    out.add(m[1]);
  }
  return [...out].sort();
}

/** 模板钩子上的键：data-*-text / -title / -label / -placeholder / -aria */
function hookedKeys(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/data-(?:wb|notes)-(?:text|title|label|placeholder|aria)="([^"]*)"/g)) {
    out.add(m[1]);
  }
  return [...out].sort();
}

/** 代码里写的键 → 中文回退（用于与 zh.json 对表） */
function fallbacks(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /\b_?tr?\(\s*'(kb\.[a-zA-Z0-9_.]+)'\s*,\s*'((?:[^'\\]|\\.)*)'/g;
  for (const m of source.matchAll(re)) {
    if (!map.has(m[1])) {
      // 源码里的转义序列在运行时才是真字符：\n → 换行、\' → 单引号、\\ → 反斜杠。
      // 不反转义会把"写法正确"的换行误报成文案漂移（已踩过一次）。
      const unescaped = m[2]
        .replace(/\\n/g, '\n')
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, '\\');
      map.set(m[1], unescaped);
    }
  }
  return map;
}

describe('知识库 i18n 键完备性（跨模块）', () => {
  it('扫到的模块数量与预期一致（防止正则失配后静默通过）', () => {
    expect(moduleFiles.length).toBeGreaterThanOrEqual(8);
    expect(moduleFiles).toContain('kb-workbench.js');
    expect(moduleFiles).toContain('kb-notes.js');
  });

  it('zh / en 必须完整：代码里用到的每个键都存在（缺键会静默回退中文）', () => {
    const missing: string[] = [];
    for (const file of moduleFiles) {
      const source = fs.readFileSync(path.join(modulesDir, file), 'utf8');
      for (const key of usedKeys(source)) {
        for (const lang of ['zh', 'en'] as const) {
          if (!dicts[lang][key]) missing.push(`${file}: ${lang} 缺 ${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  /**
   * ja / pt 的缺口是**既有债务**（这两份 locale 整体就比 zh/en 少两千多个键，不是本次改动造成的）。
   * 这里不假装它不存在，也不让它继续扩大：锁在实测值上，新增键必须四份齐全。
   * （口径与仓库里的 shared-ui-adoption-guard 基线一致：冻结存量，不许抬高。）
   */
  const JA_PT_MISSING_BASELINE = 252;

  it(`ja / pt 的缺键数不得超过既有基线（当前 ${JA_PT_MISSING_BASELINE}）`, () => {
    const missing: string[] = [];
    for (const file of moduleFiles) {
      const source = fs.readFileSync(path.join(modulesDir, file), 'utf8');
      for (const key of usedKeys(source)) {
        for (const lang of ['ja', 'pt'] as const) {
          if (!dicts[lang][key]) missing.push(`${file}: ${lang} 缺 ${key}`);
        }
      }
    }
    // 按语言分别计数（基线是"每种语言的缺键数"，不是两语言合计）
    const byLang: Record<string, number> = {};
    for (const entry of missing) {
      const lang = entry.includes(': ja 缺 ') ? 'ja' : 'pt';
      byLang[lang] = (byLang[lang] || 0) + 1;
    }
    for (const lang of ['ja', 'pt']) {
      const count = byLang[lang] || 0;
      if (count > JA_PT_MISSING_BASELINE) {
        const extra = missing.filter((m) => m.includes(`: ${lang} 缺 `)).slice(0, 10);
        throw new Error(`${lang} 缺键从 ${JA_PT_MISSING_BASELINE} 涨到 ${count}；新增示例：\n${extra.join('\n')}`);
      }
      expect(count, `${lang} 缺键数`).toBeLessThanOrEqual(JA_PT_MISSING_BASELINE);
    }
  });

  it('模板钩子上的键都真实存在，且不是运行时表达式', () => {
    const bad: string[] = [];
    for (const file of moduleFiles) {
      const source = fs.readFileSync(path.join(modulesDir, file), 'utf8');
      for (const key of hookedKeys(source)) {
        // 钩子只承载静态文案：值本身必须是一个键，不允许出现 ${…} / ? / 空格
        if (!/^[a-z][a-zA-Z0-9_.]*$/.test(key)) {
          bad.push(`${file}: 钩子值不是静态键 → ${key}`);
          continue;
        }
        for (const lang of locales) {
          if (!dicts[lang][key]) bad.push(`${file}: ${lang} 缺钩子键 ${key}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  /**
   * 既有的 15 条"代码回退 ≠ zh.json"是本次之前就存在的（多半是后来在 locale 里改了措辞、
   * 没同步代码里的回退）。冻结它们，但**不许再新增**：两边不一致时，缺键用户看到的是旧措辞，
   * 有键用户看到的是新措辞，同一个界面会突然换说法。
   */
  const KNOWN_FALLBACK_DRIFT = new Set([
    'kb-discover.js: kb.discover.featured_subtitle',
    'kb-quiz.js: kb.quiz.menu_export',
    'kb-quiz.js: kb.quiz.q_source_hint',
    'kb-transcript-correct.js: kb.glossary.title',
    'kb-transcript-correct.js: kb.transcriptCorrect.scan_done',
    'kb-transcript-correct.js: kb.transcriptCorrect.scan_truncated',
    'kb-transcript-correct.js: kb.transcriptCorrect.sync',
    'kb-transcript-correct.js: kb.transcriptCorrect.sync_aligned',
    'kb-transcript-correct.js: kb.transcriptCorrect.sync_done',
    'kb-transcript-correct.js: kb.transcriptCorrect.sync_hint',
    'kb-transcript-correct.js: kb.transcriptCorrect.sync_linked',
    'kb-transcript-correct.js: kb.transcriptCorrect.sync_missing_row',
    'kb-transcript-correct.js: kb.transcriptCorrect.sync_section',
    'kb-transcript-correct.js: kb.transcriptCorrect.sync_seed_added',
    'kb-transcript-correct.js: kb.transcriptCorrect.sync_source_ontology',
  ]);

  it('zh 的值与代码里的中文回退逐字一致（既有 15 条已冻结，不许新增）', () => {
    const drift: string[] = [];
    for (const file of moduleFiles) {
      const source = fs.readFileSync(path.join(modulesDir, file), 'utf8');
      for (const [key, fallback] of fallbacks(source)) {
        const zh = dicts.zh[key];
        if (!zh || zh === fallback) continue;
        if (KNOWN_FALLBACK_DRIFT.has(`${file}: ${key}`)) continue;
        drift.push(`${file}: ${key}\n    代码回退: ${fallback}\n    zh.json : ${zh}`);
      }
    }
    expect(drift).toEqual([]);
  });

  it('每个 kb 模块都订阅了 i18n-change（动态文案要能跟着语言重刷）', () => {
    const missing = moduleFiles.filter((file) => {
      const source = fs.readFileSync(path.join(modulesDir, file), 'utf8');
      return !source.includes('i18n-change');
    });
    expect(missing).toEqual([]);
  });
});
