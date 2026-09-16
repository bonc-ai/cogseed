/**
 * 知识库测验面板（kb-quiz.js）——作答状态机 + 结果页 + 文案/控件约束。
 *
 * 分两层：
 *   A. 纯函数行为（判分/汇总/导出文本）：直接跑真代码，覆盖"不自动判简答""未作答按
 *      跳过计入""三类计数互斥"这些容易做错的规则；
 *   B. 源码契约（逐题流程、提示、评分台账、来源跳转、待开发分享、i18n/共享原语）：
 *      面板的 shell 是模板 + 事件绑定，这一层钉住"必须接哪个通道、必须说什么话"，
 *      真实交互由真机 CDP 复核（见交付说明）。
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const SRC = path.join(__dirname, '../../src/renderer/modules/kb-quiz.js');
const source = () => fs.readFileSync(SRC, 'utf8');

function loadModule() {
  const context: any = {
    console,
    Promise,
    JSON,
    String,
    Number,
    Boolean,
    Math,
    Date,
    RegExp,
    Array,
    Object,
    Set,
    Map,
    Error,
    isNaN,
    setTimeout,
    clearTimeout,
    window: { addEventListener: vi.fn() },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source(), context, { filename: 'kb-quiz.js' });
  return context.window;
}

const utils = () => loadModule().__kbQuizUtils;

const Q = (over: Record<string, unknown> = {}) => ({
  id: 1, type: 'single', question: 'Q?', options: ['A 选项', 'B 选项'], answer: 'A 选项', explain: '解释', ...over,
});

describe('kb-quiz 纯函数', () => {
  it('normText 归一：全角转半角、去空白与首尾标点、忽略大小写与字母前缀', () => {
    const { normText } = utils();
    expect(normText('Ａ. 选项，')).toBe('a选项');
    expect(normText('  Claude ')).toBe('claude');
    expect(normText('Ｂ、答案；')).toBe('b答案');
    expect(normText(null)).toBe('');
  });

  it('单选题自动判分；简答题**不**自动判分（返回 null）', () => {
    const { isCorrect } = utils();
    expect(isCorrect(Q(), 'A 选项')).toBe(true);
    expect(isCorrect(Q(), 'Ａ． 选项')).toBe(true);
    expect(isCorrect(Q(), 'B 选项')).toBe(false);
    expect(isCorrect(Q(), '')).toBeNull();
    expect(isCorrect(Q({ type: 'short', options: [], answer: '要点一；要点二' }), '要点一')).toBeNull();
  });

  it('汇总：答对/答错/跳过互斥，未作答按跳过计入，简答按自评计入', () => {
    const { scoreQuiz } = utils();
    const questions = [
      Q({ id: 1, answer: 'A 选项' }),
      Q({ id: 2, answer: 'A 选项' }),
      Q({ id: 3, type: 'short', options: [], answer: '要点' }),
      Q({ id: 4, type: 'short', options: [], answer: '要点' }),
      Q({ id: 5, answer: 'A 选项' }),
    ];
    const summary = scoreQuiz(
      questions,
      { 1: 'A 选项', 2: 'B 选项', 3: '我的答案', 4: '我的答案' }, // 5 完全没作答
      { 2: false },
      { 3: 'right', 4: 'wrong' },
    );
    expect(summary.total).toBe(5);
    expect(summary.right).toBe(2);   // 1 对 + 3 自评对
    expect(summary.wrong).toBe(2);   // 2 错 + 4 自评错
    expect(summary.skipped).toBe(1); // 5 未作答
    expect(summary.right + summary.wrong + summary.skipped).toBe(summary.total);
    expect(summary.percent).toBe(40);
    expect(summary.items.map((i: any) => i.status)).toEqual(['right', 'wrong', 'right', 'wrong', 'skipped']);
  });

  it('显式跳过覆盖已选答案（跳过就是跳过，不计入对错）', () => {
    const { scoreQuiz } = utils();
    const summary = scoreQuiz([Q({ id: 1, answer: 'A 选项' })], { 1: 'A 选项' }, { 1: true }, {});
    expect(summary).toMatchObject({ right: 0, wrong: 0, skipped: 1 });
  });

  it('简答作答但未自评 → 按跳过计（不猜对错）', () => {
    const { scoreQuiz } = utils();
    const summary = scoreQuiz([Q({ id: 1, type: 'short', options: [], answer: '要点' })], { 1: '我写的' }, {}, {});
    expect(summary.items[0].status).toBe('skipped');
  });

  it('空题库不炸，percent 为 0', () => {
    const { scoreQuiz } = utils();
    expect(scoreQuiz([], {}, {}, {})).toMatchObject({ total: 0, right: 0, wrong: 0, skipped: 0, percent: 0 });
  });

  it('错题筛选：答错与跳过都算"要重练"，答对不进（简答未自评按跳过）', () => {
    const { wrongQuestions } = utils();
    const questions = [
      Q({ id: 1, answer: 'A 选项' }),
      Q({ id: 2, answer: 'A 选项' }),
      Q({ id: 3, type: 'short', options: [], answer: '要点' }),
      Q({ id: 4, answer: 'A 选项' }),
    ];
    const bad = wrongQuestions(questions, { 1: 'A 选项', 2: 'B 选项', 3: '我写的' }, {}, {});
    expect(bad.map((q: any) => q.id)).toEqual([2, 3, 4]); // 1 对；2 错；3 未自评=跳过；4 未作答=跳过
    // 全部答对时没有错题
    expect(wrongQuestions([Q({ id: 1 })], { 1: 'A 选项' }, {}, {})).toEqual([]);
  });

  it('汇总带进度口径：做过的题（含跳过）算推进，用于顶部进度条', () => {
    const { scoreQuiz } = utils();
    const questions = [Q({ id: 1 }), Q({ id: 2 }), Q({ id: 3 }), Q({ id: 4 })];
    const half = scoreQuiz(questions, { 1: 'A 选项', 2: 'B 选项' }, { 2: true }, {});
    expect(half.progress).toBe(50); // 第 1 题作答 + 第 2 题显式跳过 = 动过 2/4
    expect(scoreQuiz(questions, { 1: 'A 选项' }, {}, {}).progress).toBe(25); // 只答了 1 题，未作答的不算推进
    expect(scoreQuiz(questions, {}, {}, {}).progress).toBe(0);
  });

  it('导出 HTML（打印/PDF）：含题干、选项、答案、解析、来源与得分（结果页时）', () => {
    const { quizToHtml } = utils();
    const html = quizToHtml('报告 · 测验', [Q({ id: 1, source: '报告.md' })], ['报告.md'], { phase: 'results', right: 1, total: 1, percent: 100 });
    expect(html).toContain('报告 · 测验');
    expect(html).toContain('A. A 选项');
    expect(html).toContain('正确答案');
    expect(html).toContain('解析');
    expect(html).toContain('报告.md');
    expect(html).toContain('100%');
    // 未提交结果页时不塞得分
    const plain = quizToHtml('T', [Q({ id: 1 })], [], { phase: 'answering', right: 0, total: 1, percent: 0 });
    expect(plain).not.toContain('您的得分');
  });

  it('导出 Markdown：含来源、选项字母、答案、解析、原文依据', () => {
    const { quizToMarkdown } = utils();
    const md = quizToMarkdown('报告 · 测验', [
      Q({ id: 1, source: '报告.md' }),
      Q({ id: 2, type: 'short', options: [], answer: '要点一；要点二', source: '计划.md' }),
    ], ['报告.md', '计划.md']);
    expect(md).toContain('# 报告 · 测验');
    expect(md).toContain('来源: 报告.md、计划.md');
    expect(md).toContain('- A. A 选项');
    expect(md).toContain('- B. B 选项');
    expect(md).toContain('正确答案: A 选项');
    expect(md).toContain('解析: 解释');
    expect(md).toContain('原文依据: 计划.md');
  });
});

describe('kb-quiz 契约', () => {
  it('逐题作答：选项只标选中，不在点击时judge；由「下一个/查看结果」推进', () => {
    const src = source();
    expect(src).toContain('function _submitCurrent()');
    expect(src).toMatch(/btn\.className = 'kb-qz-option'[\s\S]{0,300}is-selected/);
    expect(src).toMatch(/function _selectOption\(q, optionText\)[\s\S]{0,220}_state\.answers\[q\.id\] = optionText/);
    // 点击选项只走 _selectOption（记答案 + 重渲染），不直接判对错：
    // 对错只在"提交后"（即时解析模式的揭晓块 / 结果页 / 简答自评）出现
    expect(src).toContain("btn.addEventListener('click', () => _selectOption(q, String(opt)));");
    const select = src.slice(src.indexOf('function _selectOption(q, optionText)'), src.indexOf('function _skipCurrent()'));
    expect(select).not.toContain('is-right');
    expect(select).not.toContain('is-wrong');
    expect(select).not.toContain('correct');
  });

  it('提交前未作答要提示，而不是静默跳题', () => {
    const src = source();
    expect(src).toContain("_toast(_tr('kb.quiz.need_answer'");
  });

  it('提示走 kb.quiz.hint，按题缓存，拿不到就如实说', () => {
    const src = source();
    expect(src).toContain("invoke('kb.quiz.hint'");
    expect(src).toMatch(/question: q\.question/);
    expect(src).toMatch(/fingerprint: _state\.fingerprint/);
    expect(src).toMatch(/qid: q\.id/);
    expect(src).toContain("_tr('kb.quiz.hint_empty'");
    expect(src).toContain("_tr('kb.quiz.hint_tag_none'");
  });

  it('评分（优质/劣质）走 kb.quiz.feedback，且是小图标工具不常驻占位', () => {
    const src = source();
    expect(src).toContain("invoke('kb.quiz.feedback'");
    expect(src).toMatch(/fingerprint: _state\.fingerprint, qid: q\.id, verdict/);
    expect(src).toMatch(/rate_good/);
    expect(src).toMatch(/rate_bad/);
    // 图标来自共享图标注册表（thumbs-up / thumbs-down），不是一个占位的大按钮
    expect(src).toContain("RATE_ICON = { good: 'thumbs-up', bad: 'thumbs-down' }");
    expect(src).toMatch(/data-qz-rate/);
    expect(src).toMatch(/setAttribute\('aria-label', label\)/);
  });

  it('结果页：得分 + 三类计数 + 查看逐题详情（我的答案/正确答案/解析/原文依据）', () => {
    const src = source();
    expect(src).toContain("_tr('kb.quiz.score'");
    expect(src).toContain("_tr('kb.quiz.stat_right'");
    expect(src).toContain("_tr('kb.quiz.stat_wrong'");
    expect(src).toContain("_tr('kb.quiz.stat_skipped'");
    expect(src).toContain("_tr('kb.quiz.show_detail'");
    expect(src).toContain("_tr('kb.quiz.your_answer'");
    expect(src).toContain("_tr('kb.quiz.correct_answer'");
    expect(src).toContain("_tr('kb.quiz.reference'");
    expect(src).toContain("_tr('kb.quiz.q_source'");
  });

  it('结果页两个动作分开：再测一次（同一套题）vs 生成后续测验（同源新题）', () => {
    const src = source();
    expect(src).toMatch(/function _retest\(\)[\s\S]{0,300}_resetAnswers\(\)/);
    expect(src).toMatch(/function _regenerate\(\)[\s\S]{0,400}host\.onRegenerate/);
    expect(src).toContain("_tr('kb.quiz.retest'");
    expect(src).toContain("_tr('kb.quiz.regenerate'");
  });

  it('顶部只留必要控件：标题、查看 N 个来源、放大、更多、关闭（复制/导出/分享在更多菜单里）', () => {
    const src = source();
    expect(src).toContain('id="kb-qz-title-text"');
    expect(src).toContain("_iconButtonHtml('kb-qz-max'");
    expect(src).toContain("_iconButtonHtml('kb-qz-more'");
    expect(src).toContain("_iconButtonHtml('kb-qz-close'");
    expect(src).toContain('id="kb-qz-sources-chip"');
    expect(src).toContain("_tr('kb.quiz.menu_copy'");
    expect(src).toContain("_tr('kb.quiz.menu_export_md'");
    expect(src).toContain("_tr('kb.quiz.menu_export_pdf'");
    // 顶部不再有常驻的分享按钮
    expect(src).not.toContain("_iconButtonHtml('kb-qz-share'");
  });

  it('题目/选项/答案等模型输出一律走 textContent（不拼 innerHTML）', () => {
    const src = source();
    expect(src).toMatch(/qText\.textContent = String\(q\.question \|\| ''\)/);
    expect(src).toMatch(/text\.textContent = String\(opt\)/);
    expect(src).toMatch(/li\.textContent = c/);
    expect(src).not.toMatch(/innerHTML = [^`'"]*q\.question/);
  });

  it('顶部有进度条（不只文字），进度文字是"当前状态"一档', () => {
    const src = source();
    expect(src).toContain('kb-qz-progress-track');
    expect(src).toContain('kb-qz-progress-fill');
    expect(src).toMatch(/fill\.style\.width = `\$\{pct\}%`/);
    for (const key of ['kb.quiz.progress', 'kb.quiz.progress_done']) expect(src).toContain(key);
  });

  it('视觉层级：题干独立留白、选项 hover/选中态、原文依据弱化为次要信息', () => {
    const src = source();
    const css = fs.readFileSync(path.join(__dirname, '../../src/renderer/kb-quiz.css'), 'utf8');
    // 题干与选项的留白由样式承担（题干 margin 上 4 下 5）
    expect(css).toMatch(/\.kb-qz-question \{[^}]*margin: var\(--space-4\) 0 var\(--space-5\)/);
    // 选项 hover 整行浅底 + 选中态
    expect(css).toMatch(/\.kb-qz-option:hover \{ background: var\(--kb-hover\)/);
    expect(css).toMatch(/\.kb-qz-option\.is-selected \{/);
    // 原文依据小字浅灰 + 下划线链接
    expect(css).toMatch(/\.kb-qz-qsource \{[^}]*font-size: var\(--font-size-1\)[^}]*color: var\(--kb-text3\)/);
    expect(css).toMatch(/\.kb-qz-qsource-link \{[^}]*text-decoration: underline/);
    // 底部次要操作是浅色文字按钮
    expect(css).toContain('.kb-qz-textbtn');
    expect(src).toMatch(/hintBtn\.className = 'kb-qz-textbtn/);
    expect(src).toMatch(/skipBtn\.className = 'kb-qz-textbtn/);
  });

  it('弹窗尺寸自适应、不占满大屏；窄屏有压缩规则', () => {
    const css = fs.readFileSync(path.join(__dirname, '../../src/renderer/kb-quiz.css'), 'utf8');
    expect(css).toMatch(/\.kb-qz-panel \{[^}]*width: min\(620px, 92vw\)/);
    expect(css).toMatch(/\.kb-qz-panel\.is-max \{[^}]*width: min\(1080px, 96vw\)/);
    expect(css).toMatch(/@media \(max-width: 640px\)/);
  });

  it('解析时机可选：整套 / 每题即时（切换后即时模式会揭晓答案与解析）', () => {
    const src = source();
    expect(src).toContain("_tr('kb.quiz.mode_end'");
    expect(src).toContain("_tr('kb.quiz.mode_instant'");
    expect(src).toMatch(/function _setInstant\(next\)/);
    expect(src).toMatch(/function _isRevealed\(q\)/);
    expect(src).toMatch(/if \(revealed\) body\.appendChild\(_revealBlock\(q, given\)\)/);
  });

  it('提示分两级：一级线索 → 二级原文片段（片段来自主进程材料，不打模型）', () => {
    const src = source();
    expect(src).toContain('level: 1');
    expect(src).toMatch(/function _loadSnippet\(q\)[\s\S]{0,600}level: 2/);
    expect(src).toContain("_tr('kb.quiz.hint_level2'");
    expect(src).toContain("_tr('kb.quiz.hint_tag_snippet'");
    expect(src).toMatch(/function _hintBlock\(q\)/);
  });

  it('原文依据 hover 预览片段（不离开测验就能核对），点击仍打开原文', () => {
    const src = source();
    expect(src).toMatch(/link\.addEventListener\('mouseenter', \(\) => _previewSnippet\(q, link\)\)/);
    expect(src).toMatch(/link\.addEventListener\('click', \(\) => _openSource\(String\(q\.source\)\)\)/);
    expect(src).toContain('kb-qz-snippet-pop');
  });

  it('错题集：结果页可"只练错题"，跳过的题可一键回看', () => {
    const src = source();
    expect(src).toMatch(/function _practiceWrong\(wrong\)/);
    expect(src).toContain("_tr('kb.quiz.practice_wrong'");
    expect(src).toMatch(/function _backToSkipped\(summary\)/);
    expect(src).toContain("_tr('kb.quiz.back_skipped'");
    expect(src).toContain('kb-qz-wrong-only');
    expect(src).toContain('kb-qz-back-skipped');
  });

  it('题目可现场修订，并把修订回写会话历史（host.onQuestionsChanged）', () => {
    const src = source();
    expect(src).toMatch(/function _openEditor\(q\)/);
    expect(src).toContain('kb-qz-edit-question');
    expect(src).toContain('kb-qz-edit-answer');
    expect(src).toContain('kb-qz-edit-save');
    expect(src).toMatch(/onQuestionsChanged\(_state\.pool\)/);
    expect(src).toMatch(/q\.question = nextQuestion;/);
  });

  it('导出：Markdown + PDF（PDF 走 kb.quiz.exportPdf，主进程 printToPDF）', () => {
    const src = source();
    expect(src).toContain("_download(`${_safeName()}-\${Date.now()}.md`");
    expect(src).toMatch(/invoke\(|_invoke\('kb\.quiz\.exportPdf'/);
    expect(src).toContain("_invoke('kb.quiz.exportPdf'");
    expect(src).toContain('quizToHtml');
  });

  it('快捷键：A–D 选择、Enter 提交、←→ 切题、F 提示、S 跳过', () => {
    const src = source();
    expect(src).toMatch(/function _onKeydown\(e\)/);
    expect(src).toMatch(/\^\[a-dA-D\]\$\/\.test\(e\.key\)/);
    expect(src).toMatch(/e\.key === 'Enter'/);
    expect(src).toMatch(/ArrowRight/);
    expect(src).toMatch(/e\.key === 'f' \|\| e\.key === 'F'/);
    expect(src).toMatch(/e\.key === 's' \|\| e\.key === 'S'/);
    // 在输入框里打字时不抢键
    expect(src).toMatch(/const typing = tag === 'input' \|\| tag === 'textarea'/);
  });

  it('防误关闭 + 作答进度自动保存/恢复（重开继续）', () => {
    const src = source();
    expect(src).toMatch(/function _saveProgress\(\)[\s\S]{0,600}localStorage\.setItem\(PROGRESS_KEY/);
    expect(src).toMatch(/function _loadProgress\(\)/);
    expect(src).toContain('cogseed.kb.quiz.progress.v1');
    expect(src).toMatch(/function _requestClose\(\)[\s\S]{0,300}_hasUnfinished\(\)/);
    expect(src).toContain("_tr('kb.quiz.close_confirm_note'");
    expect(src).toContain('kb-qz-confirm-keep');
  });

  it('待开发分享不再常驻头部，移到更多菜单里（弱化）', () => {
    const src = source();
    // 头部模板里不应再有分享按钮与"待开发"chip
    const head = src.slice(src.indexOf('class="kb-qz-head"'), src.indexOf('class="kb-qz-progress"'));
    expect(head).not.toContain('kb-qz-share');
    expect(head).not.toContain('soon-chip');
    // 菜单里保留分享入口，但禁用并如实标"待开发"
    expect(src).toMatch(/item\(_tr\('kb\.quiz\.share'[\s\S]{0,140}disabled: true/);
    expect(src).toContain("_tr('kb.quiz.soon', '待开发')");
  });

  it('Esc 关闭、点遮罩关闭、i18n-change 重刷', () => {
    const src = source();
    expect(src).toMatch(/e\.key === 'Escape'[\s\S]{0,600}_requestClose\(\)/);
    expect(src).toMatch(/if \(target === el\) \{ _requestClose\(\); return; \}/);
    expect(src).toContain("window.addEventListener('i18n-change'");
  });

  it('新模块零裸控件（shared-ui-adoption-guard 对新增文件额度为 0）', () => {
    expect((source().match(/<(?:button|input|textarea|select)\b/gi) || []).length).toBe(0);
    // 控件来自共享原语（外壳按钮）+ 共享按钮皮肤（动态按钮穿 ui-button 类，不自造皮肤）
    expect(source()).toContain('window.uiIconButton');
    expect(source()).toContain('ui-button ui-button--');
    expect(source()).toContain('ui-button__label');
  });

  it('用到的 kb.quiz.* 文案在 zh/en 都有，且占位符一致、en 不含汉字', () => {
    const keys = [...new Set(Array.from(source().matchAll(/_tr\('(kb\.quiz\.[a-z_]+)'/g), (m) => m[1]))];
    expect(keys.length).toBeGreaterThan(30);
    const zh = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/renderer/locales/zh.json'), 'utf8'));
    const en = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/renderer/locales/en.json'), 'utf8'));
    const placeholders = (s: string) => Array.from(String(s).matchAll(/\{(\w+)\}/g), (m) => m[1]).sort().join(',');
    const missing = keys.filter((k) => !(k in zh) || !(k in en));
    expect(missing).toEqual([]);
    const mismatched = keys.filter((k) => placeholders(zh[k]) !== placeholders(en[k]));
    expect(mismatched).toEqual([]);
    const hanInEn = keys.filter((k) => /[\u4e00-\u9fff]/.test(en[k]));
    expect(hanInEn).toEqual([]);
  });
});
