// ─── 知识库测验：答题 / 结果面板 — classic script (window.KbQuizPanel) ───
//
// 对标 NotebookLM Studio 的「测验」，并按使用侧反馈补齐两层体验：
//   视觉：题干/选项的层级与留白、选项 hover 与选中态、**进度条**、次要信息浅灰、
//         底部次要操作改浅色文字按钮、来源/分享移出常驻区、弹窗宽度自适应；
//   体验：解析时机可选（整套 / 每题即时）、提示分两级（线索 → 原文片段）、
//         原文依据 hover 预览、跳过的题一键回看、错题只练一遍、题目可现场修订、
//         快捷键 A–D 选择 / Enter 提交 / ←→ 切题 / F 提示 / S 跳过、作答进度自动
//         保存与防误关闭、导出 Markdown / PDF / 复制。
//
// 分工（与仓库既有约定一致）：
//   * 出题在主进程（kb.quiz）；本模块只呈现与作答，不重新出题（除用户手改，且改后
//     经 host 回写会话历史）；
//   * 题干/选项/答案/解析一律 textContent（模型输出不拼 innerHTML）；
//   * 控件走共享原语 uiButton/uiIconButton，可见文案走 _tr（zh/en 词表）；
//   * 测不了的不假装：简答题不自动判分（用户对照参考答案自评）；提示拿不到材料线索就
//     如实说"材料未覆盖"；评分只有真记上才说"已记录"；原文只精确到文件（题目里
//     没有段落锚点，就不假装能高亮到段落）。
(function () {
  const PROGRESS_KEY = 'cogseed.kb.quiz.progress.v1';
  const RATE_ICON = { good: 'thumbs-up', bad: 'thumbs-down' };
  let _modalController = null;

  const _state = {
    open: false,
    pool: [],           // 本次测验的题目全集（"错题重练"用来回到全量）
    questions: [],      // 当前作答集合（错题重练 = pool 的子集）
    sources: [],
    fingerprint: '',
    title: '',
    dir: null,
    spaceId: null,
    index: 0,
    answers: {},
    skipped: {},
    selfMark: {},
    hints: {},          // qid -> { level1?: { hint, covered } }
    hintsOpen: {},      // qid -> false | 1 | 2
    hintLoading: {},
    snippets: {},       // qid -> { text, covered }
    rating: {},         // qid -> 'good' | 'bad'
    edits: {},          // qid -> true（用户修订过）
    submitted: {},      // qid -> true（即时解析模式下本题已提交，就地揭晓）
    phase: 'answering', // answering | results
    showDetail: false,
    instant: false,     // 每题即时给答案 + 解析
    maximize: false,
    menuOpen: false,
    sourcesOpen: false,
    closeConfirm: false,
    retesting: false,
    wrongOnly: false,
    host: null,
  };

  function _tr(key, fallback, vars) {
    const translated = typeof window.t === 'function' ? window.t(key, vars || {}) : '';
    return translated && translated !== key ? translated : fallback;
  }

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _toast(msg, variant) {
    if (typeof uiToast === 'function') uiToast(msg, variant ? { variant } : undefined);
  }

  // ── 纯函数（可单测）─────────────────────────────────────────────────
  /** 比对归一：全角→半角，只留字母/数字/中日韩，忽略空白标点与大小写。 */
  function normText(s) {
    return String(s == null ? '' : s)
      .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/[^\p{L}\p{N}]/gu, '')
      .toLowerCase();
  }

  /** 单选题自动判分；简答题不自动判分（返回 null，由用户自评）。 */
  function isCorrect(q, answer) {
    if (!q || q.type !== 'single') return null;
    const given = normText(answer);
    if (!given) return null;
    return given === normText(q.answer);
  }

  /** 结果汇总：right / wrong / skipped 三类互斥；未作答与未自评一律按跳过算（不猜）。 */
  function scoreQuiz(questions, answers, skipped, selfMark) {
    const list = Array.isArray(questions) ? questions : [];
    const items = list.map((q) => {
      const given = String((answers || {})[q.id] ?? '');
      const isSkipped = Boolean((skipped || {})[q.id]) || !given.trim();
      if (isSkipped) return { qid: q.id, status: 'skipped', given: '' };
      if (q.type === 'single') return { qid: q.id, status: isCorrect(q, given) ? 'right' : 'wrong', given };
      const mark = (selfMark || {})[q.id];
      if (mark === 'right') return { qid: q.id, status: 'right', given };
      if (mark === 'wrong') return { qid: q.id, status: 'wrong', given };
      return { qid: q.id, status: 'skipped', given };
    });
    const right = items.filter((i) => i.status === 'right').length;
    const wrong = items.filter((i) => i.status === 'wrong').length;
    const skippedCount = items.filter((i) => i.status === 'skipped').length;
    const total = items.length;
    // 进度条口径 = **用户实际动过的题**（作答过 或 显式点过跳过）；
    // 没作答的题在 items 里也归为 skipped，但那不是"推进"，不能算进进度。
    const answeredGiven = items.filter((i) => String(i.given || '').trim() !== '').length;
    const explicitSkips = Object.keys(skipped || {}).length;
    const touched = Math.min(total, answeredGiven + explicitSkips);
    return {
      total, right, wrong, skipped: skippedCount, items,
      answered: right + wrong,
      percent: total ? Math.round((right / total) * 100) : 0,
      progress: total ? Math.round((touched / total) * 100) : 0,
    };
  }

  /** 错题（答错或跳过）——「只练错题」用。 */
  function wrongQuestions(questions, answers, skipped, selfMark) {
    const summary = scoreQuiz(questions, answers, skipped, selfMark);
    const bad = new Set(summary.items.filter((i) => i.status !== 'right').map((i) => i.qid));
    return (questions || []).filter((q) => bad.has(q.id));
  }

  /** 导出用 Markdown：题目 + 选项 + 答案 + 解析 + 原文依据（不含作答）。 */
  function quizToMarkdown(title, questions, sources) {
    const lines = [`# ${title || _tr('kb.quiz.title', '测验')}`, ''];
    if (Array.isArray(sources) && sources.length) lines.push(`${_tr('kb.quiz.md_sources', '来源')}: ${sources.join('、')}`, '');
    (questions || []).forEach((q, i) => {
      lines.push(`## ${i + 1}. ${String(q.question || '')}`);
      if (q.type === 'single' && Array.isArray(q.options)) {
        q.options.forEach((o, j) => lines.push(`- ${String.fromCharCode(65 + j)}. ${String(o)}`));
      }
      lines.push('', `${_tr('kb.quiz.correct_answer', '正确答案')}: ${String(q.answer || '')}`);
      if (q.explain) lines.push(`${_tr('kb.quiz.explain', '解析')}: ${String(q.explain)}`);
      if (q.source) lines.push(`${_tr('kb.quiz.q_source', '原文依据')}: ${String(q.source)}`);
      lines.push('');
    });
    return lines.join('\n');
  }

  /** 导出用 HTML（A4 打印友好，供主进程 printToPDF）。 */
  function quizToHtml(title, questions, sources, meta) {
    const head = String(title || _tr('kb.quiz.title', '测验'));
    const srcLine = Array.isArray(sources) && sources.length ? sources.join('、') : '';
    const rows = (questions || []).map((q, i) => {
      const opts = q.type === 'single' && Array.isArray(q.options)
        ? `<ul class="opts">${q.options.map((o, j) => `<li>${_esc(String.fromCharCode(65 + j))}. ${_esc(o)}</li>`).join('')}</ul>`
        : '';
      return `<section class="q">
  <div class="qh">${i + 1}. ${_esc(q.question || '')}</div>
  ${opts}
  <div class="ans">${_esc(_tr('kb.quiz.correct_answer', '正确答案'))}：${_esc(q.answer || '')}</div>
  ${q.explain ? `<div class="ex">${_esc(_tr('kb.quiz.explain', '解析'))}：${_esc(q.explain)}</div>` : ''}
  ${q.source ? `<div class="src">${_esc(_tr('kb.quiz.q_source', '原文依据'))}：${_esc(q.source)}</div>` : ''}
</section>`;
    }).join('\n');
    const score = meta && meta.phase === 'results' && Number.isFinite(meta.total)
      ? `<div class="score">${_esc(_tr('kb.quiz.score', `您的得分 ${meta.right}/${meta.total}`, { right: meta.right, total: meta.total }))} (${meta.percent}%)</div>`
      : '';
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${_esc(head)}</title>
<style>
  body{font-family:-apple-system,"PingFang SC","Helvetica Neue",Arial,sans-serif;margin:32px;color:#14281E;line-height:1.7}
  h1{font-size:20px;margin:0 0 6px}
  .meta{color:#6E8578;font-size:12px;margin-bottom:18px}
  .score{font-size:16px;font-weight:600;margin:10px 0 18px}
  .q{margin:0 0 18px;padding-bottom:14px;border-bottom:1px solid #E5EDE8;page-break-inside:avoid}
  .qh{font-weight:600;margin-bottom:6px}
  .opts{margin:6px 0 8px 20px}
  .ans{color:#0B7A52}
  .ex{color:#3E5A4C;font-size:13px}
  .src{color:#6E8578;font-size:12px;margin-top:4px}
</style></head><body>
<h1>${_esc(head)}</h1>
${srcLine ? `<div class="meta">${_esc(_tr('kb.quiz.md_sources', '来源'))}: ${_esc(srcLine)}</div>` : ''}
${score}
${rows}
</body></html>`;
  }

  function typeLabel(q) {
    return q && q.type === 'short' ? _tr('kb.quiz.type_short', '简答') : _tr('kb.quiz.type_single', '单选');
  }

  // ── 作答进度持久化（防误关 / 重开继续）──────────────────────────────
  function _progressKey() {
    return _state.fingerprint || `${_state.title}|${_state.questions.length}`;
  }
  function _saveProgress() {
    try {
      const store = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
      store[_progressKey()] = {
        answers: _state.answers, skipped: _state.skipped, selfMark: _state.selfMark,
        index: _state.index, phase: _state.phase, instant: _state.instant, at: Date.now(),
      };
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(store));
    } catch { /* 无 localStorage：不阻塞作答 */ }
  }
  function _loadProgress() {
    try {
      const saved = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}')[_progressKey()];
      if (!saved || typeof saved !== 'object') return false;
      _state.answers = saved.answers || {};
      _state.skipped = saved.skipped || {};
      _state.selfMark = saved.selfMark || {};
      _state.index = Math.min(Math.max(0, Number(saved.index) || 0), Math.max(0, _state.questions.length - 1));
      _state.instant = saved.instant === true;
      _state.phase = saved.phase === 'results' ? 'results' : 'answering';
      return Object.keys(_state.answers).length > 0 || Object.keys(_state.skipped).length > 0;
    } catch { return false; }
  }
  function _hasUnfinished() {
    return _state.phase === 'answering'
      && (Object.keys(_state.answers).length > 0 || Object.keys(_state.skipped).length > 0);
  }

  // ── DOM 骨架 ────────────────────────────────────────────────────────
  function _root() {
    let el = document.getElementById('kb-qz-overlay');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'kb-qz-overlay';
    el.className = 'kb-qz-overlay';
    el.hidden = true;
    el.innerHTML = `
      <div class="kb-qz-panel" id="kb-qz-panel" role="dialog" aria-modal="true" aria-labelledby="kb-qz-title-text">
        <div class="kb-qz-head">
          <span class="kb-qz-head-ico">${_iconHtml('check-circle', 'kb-qz-head-icon')}</span>
          <span class="kb-qz-title" id="kb-qz-title-text">${_esc(_tr('kb.quiz.title', '测验'))}</span>
          ${window.uiButton({
            label: _tr('kb.quiz.view_sources', '查看来源', { count: 0 }),
            role: 'ghost',
            size: 'sm',
            className: 'kb-qz-source-chip',
            attrs: { id: 'kb-qz-sources-chip', 'aria-expanded': 'false' },
          })}
          <span class="kb-qz-head-actions">
            ${_iconButtonHtml('kb-qz-max', _tr('kb.quiz.maximize', '放大'), 'maximize')}
            ${_iconButtonHtml('kb-qz-more', _tr('kb.quiz.more', '更多'), 'more-horizontal')}
            ${_iconButtonHtml('kb-qz-close', _tr('kb.quiz.close', '关闭测验'), 'x')}
          </span>
          <div class="kb-qz-menu" id="kb-qz-menu" hidden></div>
          <div class="kb-qz-sources" id="kb-qz-sources" hidden></div>
        </div>
        <div class="kb-qz-progress" id="kb-qz-progress">
          ${window.uiProgressBar({ ariaLabel: _tr('kb.quiz.title', '测验'), value: 0, className: 'kb-qz-progress-track', attrs: { id: 'kb-qz-progress-track' } })}
          <span class="kb-qz-progress-text" id="kb-qz-progress-text"></span>
        </div>
        <div class="kb-qz-body" id="kb-qz-body"></div>
        <div class="kb-qz-foot" id="kb-qz-foot"></div>
      </div>`;
    document.body.appendChild(el);
    const panel = document.getElementById('kb-qz-panel');
    _modalController = panel && typeof window.uiModalController === 'function'
      ? window.uiModalController({
          overlay: el,
          dialog: panel,
          initialFocus: '#kb-qz-close',
          onRequestClose: (reason) => _requestClose(reason),
          onClose: () => _finishClose(),
        })
      : null;
    _bindShell(el);
    return el;
  }

  function _iconHtml(name, cls) {
    if (typeof window.uiIconHtml === 'function') return window.uiIconHtml(name, cls);
    if (typeof window._icon === 'function') return window._icon(name, cls);
    return '';
  }

  // 控件一律走共享原语（shared-ui-adoption-guard 对新模块的裸控件额度是 0）
  function _iconButtonHtml(id, label, icon) {
    if (typeof window.uiIconButton !== 'function') return '';
    return window.uiIconButton({ label, icon, className: 'kb-qz-icon-btn', attrs: { id } });
  }

  function _bindShell(el) {
    document.getElementById('kb-qz-close')?.addEventListener('click', () => _requestClose());
    document.getElementById('kb-qz-max')?.addEventListener('click', () => {
      _state.maximize = !_state.maximize;
      document.getElementById('kb-qz-panel')?.classList.toggle('is-max', _state.maximize);
    });
    document.getElementById('kb-qz-more')?.addEventListener('click', (e) => {
      e.stopPropagation();
      _state.menuOpen = !_state.menuOpen;
      _renderMenu();
    });
    const chip = document.getElementById('kb-qz-sources-chip');
    const toggleSources = (e) => { e.stopPropagation(); _state.sourcesOpen = !_state.sourcesOpen; _renderSources(); };
    chip?.addEventListener('click', toggleSources);

    el.addEventListener('click', (e) => {
      const target = e.target;
      if (target === el) { _requestClose(); return; }
      const inMenu = target.closest && target.closest('#kb-qz-menu, #kb-qz-more');
      if (!inMenu && _state.menuOpen) { _state.menuOpen = false; _renderMenu(); }
      const inSources = target.closest && target.closest('#kb-qz-sources, #kb-qz-sources-chip');
      if (!inSources && _state.sourcesOpen) { _state.sourcesOpen = false; _renderSources(); }
    });

    document.addEventListener('keydown', _onKeydown);
    window.addEventListener('i18n-change', () => { if (_state.open) _render(); });
  }

  /** 快捷键：A–D 选项、Enter 提交、←→/J K 切题、F 提示、S 跳过、Esc 关闭。 */
  function _onKeydown(e) {
    if (!_state.open) return;
    if (e.isComposing || e.keyCode === 229) return;
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || Boolean(e.target && e.target.isContentEditable);
    if (typing) return;
    const q = _current();
    if (_state.phase === 'answering' && q) {
      const letter = /^[a-dA-D]$/.test(e.key) ? e.key.toUpperCase().charCodeAt(0) - 65 : -1;
      if (letter >= 0 && q.type === 'single' && q.options[letter] !== undefined) {
        _selectOption(q, q.options[letter]);
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter') { e.preventDefault(); _submitCurrent(); return; }
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); _toggleHint(q); return; }
      if (e.key === 's' || e.key === 'S') { e.preventDefault(); _skipCurrent(); return; }
    }
    if ((e.key === 'ArrowRight' || e.key === 'j' || e.key === 'J') && _state.phase === 'answering' && _state.index < _state.questions.length - 1) {
      _state.index += 1;
      _saveProgress();
      _renderQuestion();
      e.preventDefault();
    }
    if ((e.key === 'ArrowLeft' || e.key === 'k' || e.key === 'K') && _state.phase === 'answering' && _state.index > 0) {
      _state.index -= 1;
      _saveProgress();
      _renderQuestion();
      e.preventDefault();
    }
  }

  // ── 渲染 ────────────────────────────────────────────────────────────
  function _render() {
    const el = document.getElementById('kb-qz-overlay');
    if (!el) return;
    const titleEl = document.getElementById('kb-qz-title-text');
    if (titleEl) titleEl.textContent = _state.title || _tr('kb.quiz.title', '测验');
    _renderSources();
    _renderMenu();
    if (_state.closeConfirm) { _renderCloseConfirm(); return; }
    if (_state.phase === 'results') _renderResults();
    else _renderQuestion();
  }

  function _renderSources() {
    const chip = document.getElementById('kb-qz-sources-chip');
    const box = document.getElementById('kb-qz-sources');
    const list = Array.isArray(_state.sources) ? _state.sources : [];
    if (chip) {
      chip.hidden = !list.length;
      const label = _tr('kb.quiz.view_sources', `查看 ${list.length} 个来源`, { count: list.length });
      const labelEl = chip.querySelector('.ui-button__label');
      if (labelEl) labelEl.textContent = label;
      else chip.textContent = label;
      chip.setAttribute('aria-expanded', String(_state.sourcesOpen));
    }
    if (!box) return;
    box.hidden = !(_state.sourcesOpen && list.length);
    box.textContent = '';
    if (box.hidden) return;
    for (const src of list) {
      const row = document.createElement('div');
      row.className = 'kb-qz-source-row';
      row.textContent = src;
      row.addEventListener('click', () => _openSource(src));
      box.appendChild(row);
    }
  }

  /** 更多菜单：解析时机 / 导出 / 分享（待开发）/ 快捷键说明。 */
  function _renderMenu() {
    const menu = document.getElementById('kb-qz-menu');
    if (!menu) return;
    menu.hidden = !_state.menuOpen;
    if (menu.hidden) { menu.textContent = ''; return; }
    menu.textContent = '';

    const section = (text) => {
      const head = document.createElement('div');
      head.className = 'kb-qz-menu-head';
      head.textContent = text;
      menu.appendChild(head);
    };
    const item = (label, hint, fn, opts = {}) => {
      const row = document.createElement('div');
      row.className = 'kb-qz-menu-item' + (opts.active ? ' is-active' : '') + (opts.disabled ? ' is-disabled' : '');
      const text = document.createElement('span');
      text.className = 'kb-qz-menu-label';
      text.textContent = label;
      row.appendChild(text);
      if (hint) {
        const tag = document.createElement('span');
        tag.className = 'kb-qz-menu-tag';
        tag.textContent = hint;
        row.appendChild(tag);
      }
      if (!opts.disabled && fn) row.addEventListener('click', (e) => { e.stopPropagation(); _closeMenu(); fn(); });
      return row;
    };

    section(_tr('kb.quiz.menu_mode', '答案解析'));
    menu.appendChild(item(_tr('kb.quiz.mode_end', '整套做完统一看解析'), null, () => _setInstant(false), { active: !_state.instant }));
    menu.appendChild(item(_tr('kb.quiz.mode_instant', '每题做完立刻看解析'), null, () => _setInstant(true), { active: _state.instant }));

    section(_tr('kb.quiz.menu_export', '导出'));
    menu.appendChild(item(_tr('kb.quiz.menu_export_md', '导出 Markdown'), null, () => _exportQuizMarkdown()));
    menu.appendChild(item(_tr('kb.quiz.menu_export_pdf', '导出 PDF（打印 / 发团队）'), null, () => _exportQuizPdf()));
    menu.appendChild(item(_tr('kb.quiz.menu_copy', '复制测验'), null, () => _copyQuiz()));

    section(_tr('kb.quiz.menu_more', '其它'));
    menu.appendChild(item(_tr('kb.quiz.share', '分享测验'), _tr('kb.quiz.soon', '待开发'), null, { disabled: true }));
    const keys = document.createElement('div');
    keys.className = 'kb-qz-menu-keys';
    keys.textContent = _tr('kb.quiz.keys_hint', '快捷键：A–D 选择 · Enter 提交 · ←→ 切题 · F 提示 · S 跳过 · Esc 关闭');
    menu.appendChild(keys);
  }

  function _closeMenu() {
    _state.menuOpen = false;
    _renderMenu();
  }

  function _setInstant(next) {
    _state.instant = next;
    _saveProgress();
    _toast(next
      ? _tr('kb.quiz.instant_on', '已切换：每题做完立刻看解析')
      : _tr('kb.quiz.instant_off', '已切换：整套做完统一看解析'), { variant: 'info' });
    _render();
  }

  function _iconNode(name, cls) {
    const span = document.createElement('span');
    span.className = cls;
    const html = _iconHtml(name, cls);
    if (html) span.innerHTML = html; // 图标来自共享注册表，不是模型输出
    return span;
  }

  function _current() {
    return _state.questions[_state.index] || null;
  }

  function _progressPercent(summary) {
    if (_state.phase === 'results') return 100;
    if (summary) return summary.progress;
    const done = Object.keys(_state.answers).length + Object.keys(_state.skipped).length;
    return _state.questions.length ? Math.round((done / _state.questions.length) * 100) : 0;
  }

  function _renderProgress(summary) {
    const progress = document.getElementById('kb-qz-progress-track');
    const text = document.getElementById('kb-qz-progress-text');
    const pct = Math.max(0, Math.min(100, _progressPercent(summary)));
    if (text) {
      text.textContent = _state.phase === 'results'
        ? _tr('kb.quiz.progress_done', `已完成 · 共 ${_state.questions.length} 题`, { total: _state.questions.length })
        : `${_tr('kb.quiz.progress', `第 ${_state.index + 1} / ${_state.questions.length} 题`, { current: _state.index + 1, total: _state.questions.length })} · ${typeLabel(_current())}`;
    }
    if (progress) {
      progress.style.setProperty('--ui-progress-value', `${pct}%`);
      progress.setAttribute('aria-valuenow', String(pct));
      if (text?.textContent) progress.setAttribute('aria-label', text.textContent);
    }
  }

  function _renderQuestion() {
    const body = document.getElementById('kb-qz-body');
    const foot = document.getElementById('kb-qz-foot');
    const q = _current();
    if (!body || !foot || !q) return;
    body.textContent = '';
    foot.textContent = '';
    _renderProgress();
    if (_state.wrongOnly) {
      const flag = document.createElement('div');
      flag.className = 'kb-qz-mode-flag';
      flag.textContent = _tr('kb.quiz.wrong_only_flag', '错题重练：只做上一轮答错 / 跳过的题');
      body.appendChild(flag);
    }

    const qText = document.createElement('div');
    qText.className = 'kb-qz-question';
    qText.textContent = String(q.question || '');
    body.appendChild(qText);

    const given = String(_state.answers[q.id] || '');
    const revealed = _isRevealed(q);
    if (q.type === 'single') {
      const list = document.createElement('div');
      list.className = 'kb-qz-options';
      q.options.forEach((opt, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        const chosen = normText(opt) === normText(given);
        const right = revealed && normText(opt) === normText(q.answer);
        btn.className = 'kb-qz-option'
          + (chosen ? ' is-selected' : '')
          + (revealed && chosen && !right ? ' is-wrong' : '')
          + (right ? ' is-right' : '');
        btn.disabled = revealed;
        const badge = document.createElement('span');
        badge.className = 'kb-qz-option-letter';
        badge.textContent = String.fromCharCode(65 + i);
        const text = document.createElement('span');
        text.className = 'kb-qz-option-text';
        text.textContent = String(opt);
        btn.append(badge, text);
        btn.addEventListener('click', () => _selectOption(q, String(opt)));
        list.appendChild(btn);
      });
      body.appendChild(list);
    } else {
      const ta = document.createElement('textarea');
      ta.className = 'kb-qz-short-input';
      ta.id = 'kb-qz-short-input';
      ta.rows = 3;
      ta.placeholder = _tr('kb.quiz.short_placeholder', '写下你的答案（简答题由你自己对照参考答案判定）');
      ta.value = given;
      ta.disabled = revealed;
      ta.addEventListener('input', () => { _state.answers[q.id] = ta.value; _saveProgress(); _renderProgress(); });
      body.appendChild(ta);
    }

    if (revealed) body.appendChild(_revealBlock(q, given));
    if (_state.hintsOpen[q.id]) body.appendChild(_hintBlock(q));
    body.appendChild(_sourceRow(q, 'question'));

    const hintBtn = document.createElement('button');
    hintBtn.type = 'button';
    hintBtn.className = 'kb-qz-textbtn kb-qz-hint-btn';
    hintBtn.id = 'kb-qz-hint';
    hintBtn.disabled = Boolean(_state.hintLoading[q.id]);
    hintBtn.textContent = _state.hintLoading[q.id]
      ? _tr('kb.quiz.hint_loading', '正在找线索…')
      : (_state.hintsOpen[q.id]
        ? _tr('kb.quiz.hint_hide', '收起提示')
        : (_state.hints[q.id] && _state.hints[q.id].level1 && _state.hints[q.id].level1.covered
          ? _tr('kb.quiz.hint_show_again', '再看提示')
          : _tr('kb.quiz.hint', '提示')));
    hintBtn.addEventListener('click', () => _toggleHint(q));
    foot.appendChild(hintBtn);

    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'kb-qz-textbtn kb-qz-skip-btn';
    skipBtn.id = 'kb-qz-skip';
    skipBtn.textContent = _tr('kb.quiz.skip', '跳过');
    skipBtn.addEventListener('click', _skipCurrent);
    foot.appendChild(skipBtn);

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'ui-button ui-button--primary ui-button--sm kb-qz-btn';
    nextBtn.id = 'kb-qz-next';
    const last = _state.index >= _state.questions.length - 1;
    const revealedHere = _isRevealed(q);
    const needSelfMark = q.type === 'short' && revealedHere === false && String(_state.answers[q.id] || '').trim() !== '';
    nextBtn.textContent = last
      ? _tr('kb.quiz.see_results', '查看结果')
      : (revealedHere && !needSelfMark ? _tr('kb.quiz.next_question', '下一题') : _tr('kb.quiz.next', '下一个'));
    nextBtn.addEventListener('click', () => _submitCurrent());
    foot.appendChild(nextBtn);

    if (q.type === 'short' && !revealed && String(_state.answers[q.id] || '').trim()) {
      const selfBox = document.createElement('span');
      selfBox.className = 'kb-qz-selfmark';
      selfBox.append(_selfMarkButton('right', q), _selfMarkButton('wrong', q));
      foot.appendChild(selfBox);
    }

    const tools = document.createElement('span');
    tools.className = 'kb-qz-qtools';
    tools.append(_editButton(q), _rateButtons(q));
    foot.appendChild(tools);
  }

  /** 即时模式：提交过就"揭晓"（判定 + 答案 + 解析）。 */
  function _isRevealed(q) {
    if (!_state.instant) return false;
    const given = String(_state.answers[q.id] || '').trim();
    if (!given) return false;
    if (q.type === 'single') return Boolean(_state.submitted[q.id]);
    return Boolean(_state.selfMark[q.id]);
  }

  function _revealBlock(q, given) {
    const box = document.createElement('div');
    box.className = 'kb-qz-reveal';
    const status = document.createElement('div');
    const correct = q.type === 'single' ? isCorrect(q, given) : _state.selfMark[q.id] === 'right';
    status.className = 'kb-qz-reveal-status ' + (correct ? 'is-right' : 'is-wrong');
    status.textContent = correct ? _tr('kb.quiz.mark_right', '答对') : _tr('kb.quiz.mark_wrong', '答错');
    box.appendChild(status);
    box.appendChild(q.type === 'single'
      ? _answerBlock(_tr('kb.quiz.correct_answer', '正确答案'), q.answer)
      : _answerBlock(_tr('kb.quiz.reference', '参考答案'), q.answer || _tr('kb.quiz.no_reference', '（无参考答案）')));
    if (q.explain) box.appendChild(_answerBlock(_tr('kb.quiz.explain', '解析'), q.explain));
    return box;
  }

  function _hintBlock(q) {
    const box = document.createElement('div');
    box.className = 'kb-qz-hint';
    const level = _state.hintsOpen[q.id];
    const hint = _state.hints[q.id] || {};
    const tag = document.createElement('span');
    tag.className = 'kb-qz-hint-tag';
    tag.textContent = level === 2
      ? _tr('kb.quiz.hint_tag_snippet', '原文片段')
      : (hint.level1 && hint.level1.covered ? _tr('kb.quiz.hint_tag', '线索') : _tr('kb.quiz.hint_tag_none', '材料未覆盖'));
    const text = document.createElement('span');
    text.className = 'kb-qz-hint-text';
    if (level === 2) {
      const snip = _state.snippets[q.id];
      text.textContent = snip && snip.text ? snip.text : _tr('kb.quiz.hint_snippet_empty', '没有取到相关原文片段');
    } else {
      text.textContent = (hint.level1 && hint.level1.hint) || _tr('kb.quiz.hint_empty', '暂时拿不到提示，请稍后重试');
    }
    box.append(tag, text);
    if (level === 1) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'kb-qz-textbtn kb-qz-hint-more';
      more.id = 'kb-qz-hint-level2';
      more.textContent = _tr('kb.quiz.hint_level2', '看原文片段');
      more.addEventListener('click', () => _loadSnippet(q));
      box.appendChild(more);
    }
    return box;
  }

  /** 原文依据行：小字浅灰 + 下划线链接 + hover 预览片段（层级上的次要信息）。 */
  function _sourceRow(q, where) {
    const row = document.createElement('div');
    row.className = 'kb-qz-qsource';
    const label = document.createElement('span');
    label.className = 'kb-qz-qsource-label';
    label.textContent = _tr('kb.quiz.q_source', '原文依据');
    row.appendChild(label);
    if (!q.source) {
      const none = document.createElement('span');
      none.className = 'kb-qz-qsource-none';
      none.textContent = _tr('kb.quiz.q_source_none', '（模型未标注来源）');
      row.appendChild(none);
      return row;
    }
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'kb-qz-qsource-link';
    link.setAttribute('data-qz-source', q.source);
    link.textContent = String(q.source);
    link.addEventListener('click', () => _openSourceAtQuestion(q));
    link.addEventListener('mouseenter', () => _previewSnippet(q, link));
    link.addEventListener('focus', () => _previewSnippet(q, link));
    link.addEventListener('mouseleave', _hideSnippetPreview);
    link.addEventListener('blur', _hideSnippetPreview);
    row.appendChild(link);
    if (where === 'question') {
      const hint = document.createElement('span');
      hint.className = 'kb-qz-qsource-hint';
      hint.textContent = _tr('kb.quiz.q_source_hint', '悬停看片段 · 点击打开原文');
      row.appendChild(hint);
    }
    return row;
  }

  let _previewEl = null;
  function _previewSnippet(q, anchorEl) {
    const show = (entry) => {
      _hideSnippetPreview();
      const box = document.createElement('div');
      box.className = 'kb-qz-snippet-pop';
      box.textContent = entry && entry.text ? entry.text : _tr('kb.quiz.hint_snippet_empty', '没有取到相关原文片段');
      document.body.appendChild(box);
      _previewEl = box;
      const r = anchorEl.getBoundingClientRect();
      const width = Math.min(420, Math.max(240, Math.round(r.width * 2)));
      box.style.width = `${width}px`;
      box.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - width - 12))}px`;
      box.style.top = `${Math.max(12, Math.min(r.bottom + 8, window.innerHeight - 140))}px`;
    };
    const cached = _state.snippets[q.id];
    if (cached) { show(cached); return; }
    Promise.resolve(_fetchSnippet(q)).then((entry) => { if (entry) show(entry); });
  }
  function _hideSnippetPreview() {
    if (_previewEl && _previewEl.parentElement) _previewEl.parentElement.removeChild(_previewEl);
    _previewEl = null;
  }

  function _answerBlock(label, text) {
    const wrap = document.createElement('div');
    wrap.className = 'kb-qz-answer';
    const tag = document.createElement('span');
    tag.className = 'kb-qz-answer-tag';
    tag.textContent = label;
    wrap.appendChild(tag);
    const clauses = _clauses(text);
    if (clauses.length > 1) {
      const ul = document.createElement('ul');
      ul.className = 'kb-qz-answer-list';
      for (const c of clauses) {
        const li = document.createElement('li');
        li.textContent = c;
        ul.appendChild(li);
      }
      wrap.appendChild(ul);
    } else {
      const p = document.createElement('span');
      p.className = 'kb-qz-answer-text';
      p.textContent = clauses[0] || String(text || '');
      wrap.appendChild(p);
    }
    return wrap;
  }

  function _clauses(text) {
    const utils = window.__kbFvUtils;
    if (utils && typeof utils.quizAnswerClauses === 'function') return utils.quizAnswerClauses(text);
    return String(text || '').split(/[\n；;]/).map((s) => s.trim()).filter(Boolean);
  }

  // ── 作答动作 ────────────────────────────────────────────────────────
  function _selectOption(q, optionText) {
    if (_isRevealed(q)) return;
    _state.answers[q.id] = optionText;
    delete _state.skipped[q.id];
    _saveProgress();
    _renderQuestion();
  }

  function _skipCurrent() {
    const q = _current();
    if (!q) return;
    _state.skipped[q.id] = true;
    delete _state.answers[q.id];
    delete _state.selfMark[q.id];
    _saveProgress();
    _advance();
  }

  function _submitCurrent() {
    const q = _current();
    if (!q) return;
    const given = String(_state.answers[q.id] || '').trim();
    if (!given) {
      _toast(_tr('kb.quiz.need_answer', '先选一个答案，或点「跳过」'), { variant: 'info' });
      return;
    }
    delete _state.skipped[q.id];
    if (q.type === 'short' && !_state.selfMark[q.id]) {
      _renderQuestion();
      _toast(_tr('kb.quiz.short_self_mark', '对照参考答案后，点「我答对了 / 没答对」'), { variant: 'info' });
      return;
    }
    _saveProgress();
    // 即时解析模式：**就地揭晓**（判定 + 答案 + 解析 + 原文入口），
    // 由用户再点「下一题」才前进——否则刚提交就跳走，等于看不到解析。
    if (_state.instant) {
      if (_state.submitted[q.id]) { _advance(); return; }
      _state.submitted[q.id] = true;
      _saveProgress();
      _renderQuestion();
      return;
    }
    _advance();
  }

  function _advance() {
    if (_state.index >= _state.questions.length - 1) { _showResults(); return; }
    _state.index += 1;
    _saveProgress();
    _renderQuestion();
    const body = document.getElementById('kb-qz-body');
    if (body && body.scrollTo) body.scrollTo({ top: 0 });
  }

  function _showResults() {
    _state.phase = 'results';
    _saveProgress();
    _renderResults();
  }

  function _selfMarkButton(kind, q) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ui-button ui-button--${kind === 'right' ? 'primary' : 'secondary'} ui-button--sm kb-qz-selfmark-btn`;
    btn.id = kind === 'right' ? 'kb-qz-self-right' : 'kb-qz-self-wrong';
    btn.textContent = kind === 'right' ? _tr('kb.quiz.self_mark_right', '我答对了') : _tr('kb.quiz.self_mark_wrong', '没答对');
    btn.addEventListener('click', () => {
      _state.selfMark[q.id] = kind;
      _saveProgress();
      if (_state.instant) { _renderQuestion(); return; }
      const last = _state.index >= _state.questions.length - 1;
      if (last) _showResults();
      else { _state.index += 1; _renderQuestion(); }
    });
    return btn;
  }

  /** 评分：小图标按钮（不常驻大按钮）；只有真记上才说"已记录"。 */
  function _rateButtons(q) {
    const wrap = document.createElement('span');
    wrap.className = 'kb-qz-rate';
    for (const [kind, label] of [['good', _tr('kb.quiz.rate_good', '优质内容')], ['bad', _tr('kb.quiz.rate_bad', '劣质内容')]]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'kb-qz-rate-btn' + (_state.rating[q.id] === kind ? ' is-active' : '');
      btn.setAttribute('data-qz-rate', kind);
      btn.setAttribute('title', label);
      btn.setAttribute('aria-label', label);
      const ico = _iconNode(RATE_ICON[kind], 'kb-qz-rate-icon');
      if (ico.childNodes.length) btn.appendChild(ico);
      // 兜底也走共享注册表：RATE_ICON 已指向 thumbs-up/thumbs-down，
      // 极端情况下取不到才出现空按钮，不再退回 emoji（规范：图标一律来自 icons.js）。
      else btn.innerHTML = _iconHtml(RATE_ICON[kind], 'kb-qz-rate-icon');
      btn.addEventListener('click', () => _rate(q, kind));
      wrap.appendChild(btn);
    }
    return wrap;
  }

  function _rate(q, verdict) {
    const invoke = window.cogseed && window.cogseed.invoke;
    const correct = q.type === 'single' ? isCorrect(q, _state.answers[q.id]) : (_state.selfMark[q.id] === 'right' ? true : null);
    const fail = () => {
      delete _state.rating[q.id];
      _toast(_tr('kb.quiz.rate_failed', '评分没记上，请稍后重试'), { variant: 'warning' });
      _render();
    };
    if (typeof invoke !== 'function') { fail(); return; }
    _state.rating[q.id] = verdict;
    _render();
    Promise.resolve(invoke('kb.quiz.feedback', {
      fingerprint: _state.fingerprint, qid: q.id, verdict,
      type: q.type, source: q.source || '', ...(correct === null ? {} : { correct }),
    })).then((res) => {
      if (!res || res.ok === false) { fail(); return; }
      _toast(verdict === 'good' ? _tr('kb.quiz.rate_thanks', '已记录：优质内容') : _tr('kb.quiz.rate_thanks_bad', '已记录：劣质内容'), { variant: 'success' });
    }).catch(fail);
  }

  function _editButton(q) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'kb-qz-textbtn kb-qz-edit-btn';
    btn.id = 'kb-qz-edit';
    btn.textContent = _tr('kb.quiz.edit', '修订本题');
    btn.addEventListener('click', () => _openEditor(q));
    return btn;
  }

  /** 现场修订题干/选项/答案：AI 出题有错时不用重新生成整套。 */
  function _openEditor(q) {
    const existing = document.getElementById('kb-qz-editor');
    if (existing) existing.remove();
    const box = document.createElement('div');
    box.className = 'kb-qz-editor';
    box.id = 'kb-qz-editor';
    const title = document.createElement('div');
    title.className = 'kb-qz-editor-title';
    title.textContent = _tr('kb.quiz.edit_title', '修订这道题（只影响本次测验）');
    box.appendChild(title);

    const qArea = document.createElement('textarea');
    qArea.className = 'kb-qz-editor-input';
    qArea.id = 'kb-qz-edit-question';
    qArea.rows = 2;
    qArea.value = String(q.question || '');
    box.appendChild(qArea);

    const optInputs = [];
    if (q.type === 'single') {
      q.options.forEach((opt, i) => {
        const input = document.createElement('input');
        input.className = 'kb-qz-editor-input';
        input.setAttribute('data-qz-edit-option', String(i));
        input.value = String(opt);
        optInputs.push(input);
        box.appendChild(input);
      });
    }
    const ansInput = document.createElement('input');
    ansInput.className = 'kb-qz-editor-input';
    ansInput.id = 'kb-qz-edit-answer';
    ansInput.value = String(q.answer || '');
    ansInput.placeholder = _tr('kb.quiz.edit_answer_ph', '正确答案（单选填选项原文）');
    box.appendChild(ansInput);

    const note = document.createElement('div');
    note.className = 'kb-qz-editor-note';
    note.textContent = _tr('kb.quiz.edit_note', '修订只改这道题的文字与答案，不改来源与题量；已作答的记录会按新答案重新判定。');
    box.appendChild(note);

    const actions = document.createElement('div');
    actions.className = 'kb-qz-editor-actions';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'ui-button ui-button--primary ui-button--sm kb-qz-btn';
    save.id = 'kb-qz-edit-save';
    save.textContent = _tr('kb.quiz.edit_save', '保存修订');
    save.addEventListener('click', () => {
      const nextQuestion = qArea.value.trim();
      if (!nextQuestion) { _toast(_tr('kb.quiz.edit_need_question', '题干不能为空'), { variant: 'warning' }); return; }
      q.question = nextQuestion;
      if (q.type === 'single' && optInputs.length) {
        const nextOptions = optInputs.map((i2) => i2.value.trim()).filter(Boolean);
        if (nextOptions.length >= 2) q.options = nextOptions;
      }
      const nextAnswer = ansInput.value.trim();
      if (nextAnswer) q.answer = nextAnswer;
      _state.edits[q.id] = true;
      box.remove();
      _saveProgress();
      _notifyQuestionsChanged();
      _toast(_tr('kb.quiz.edit_saved', '已保存修订（本次测验生效）'), { variant: 'success' });
      _render();
    });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ui-button ui-button--secondary ui-button--sm kb-qz-btn';
    cancel.id = 'kb-qz-edit-cancel';
    cancel.textContent = _tr('kb.quiz.edit_cancel', '取消');
    cancel.addEventListener('click', () => box.remove());
    actions.append(save, cancel);
    box.appendChild(actions);

    const body = document.getElementById('kb-qz-body');
    if (body) body.appendChild(box);
  }

  function _notifyQuestionsChanged() {
    const host = _state.host;
    if (host && typeof host.onQuestionsChanged === 'function') {
      try { host.onQuestionsChanged(_state.pool); } catch { /* 回写失败不影响本地修订 */ }
    }
  }

  // ── 提示 / 原文片段 ─────────────────────────────────────────────────
  function _toggleHint(q) {
    if (_state.hintsOpen[q.id]) {
      _state.hintsOpen[q.id] = false;
      _renderQuestion();
      return;
    }
    if (_state.hints[q.id] && _state.hints[q.id].level1) {
      _state.hintsOpen[q.id] = 1;
      _renderQuestion();
      return;
    }
    if (_state.hintLoading[q.id]) return;
    _state.hintLoading[q.id] = true;
    _renderQuestion();
    Promise.resolve(_invoke('kb.quiz.hint', {
      question: q.question, options: q.options || [], type: q.type, source: q.source || '',
      dir: _state.dir, spaceId: _state.spaceId, fingerprint: _state.fingerprint, qid: q.id, level: 1,
    })).then((res) => {
      _state.hintLoading[q.id] = false;
      const hint = res && typeof res.hint === 'string' && res.hint.trim() ? res.hint : '';
      _state.hints[q.id] = {
        ...(_state.hints[q.id] || {}),
        level1: hint
          ? { hint, covered: res.covered !== false }
          : { hint: _tr('kb.quiz.hint_empty', '暂时拿不到提示，请稍后重试'), covered: false },
      };
      _state.hintsOpen[q.id] = 1;
      _renderQuestion();
    }).catch(() => {
      _state.hintLoading[q.id] = false;
      _state.hints[q.id] = { ...(_state.hints[q.id] || {}), level1: { hint: _tr('kb.quiz.hint_empty', '暂时拿不到提示，请稍后重试'), covered: false } };
      _state.hintsOpen[q.id] = 1;
      _renderQuestion();
    });
  }

  /** 二级提示 = 材料原文片段（主进程直接给逐字原文，不打模型 → 离线也能用）。 */
  function _loadSnippet(q) {
    if (_state.snippets[q.id]) { _state.hintsOpen[q.id] = 2; _renderQuestion(); return; }
    Promise.resolve(_fetchSnippet(q)).then((entry) => {
      _state.hintsOpen[q.id] = 2;
      _renderQuestion();
      if (!entry) _toast(_tr('kb.quiz.hint_snippet_empty', '没有取到相关原文片段'), { variant: 'info' });
    });
  }

  function _fetchSnippet(q) {
    return Promise.resolve(_invoke('kb.quiz.hint', {
      question: q.question, answer: q.answer || '', source: q.source || '', dir: _state.dir, spaceId: _state.spaceId, qid: q.id, level: 2,
    })).then((res) => {
      const text = res && typeof res.snippet === 'string' ? res.snippet.trim() : '';
      const entry = text ? { text, covered: res.covered !== false } : null;
      _state.snippets[q.id] = entry || { text: '', covered: false };
      return entry;
    }).catch(() => { _state.snippets[q.id] = { text: '', covered: false }; return null; });
  }

  function _invoke(channel, payload) {
    const invoke = window.cogseed && window.cogseed.invoke;
    if (typeof invoke !== 'function') return Promise.resolve(null);
    return Promise.resolve(invoke(channel, payload));
  }

  function _openSource(pathText, quote) {
    const host = _state.host;
    const anchorArg = quote ? { quote } : undefined;
    if (host && typeof host.onOpenSource === 'function' && host.onOpenSource(pathText, anchorArg) !== false) return;
    _toast(_tr('kb.quiz.source_open_failed', '打不开这份来源文档（可能已被移动或删除）'), { variant: 'warning' });
  }

  /**
   * 「原文依据」点击 = 打开原文**并锁定到这一题的片段**（不再是"只报一个文件名"）。
   *
   * 片段来自 `kb.quiz.hint` level 2（主进程从材料要点里挑最相关的一段，逐字原文、不打模型），
   * 查看器侧用 quote → charStart/charEnd → `<mark>` + scrollIntoView，所以是真高亮、真滚动。
   * 悬停预览已经取过一次时直接复用缓存，点开即到。
   *
   * 拿不到片段（材料未覆盖 / 模型没标来源）时不假装能定位：照旧打开整篇，并如实说一句。
   */
  function _openSourceAtQuestion(q) {
    if (!q || !q.source) return;
    const path = String(q.source);
    const cached = _state.snippets[q.id];
    const openIt = (quote) => {
      _openSource(path, quote);
      if (!quote) _toast(_tr('kb.quiz.source_no_anchor', '没在材料里定位到这一题的原文片段，已打开整篇原文'), { variant: 'info' });
    };
    if (cached) { openIt(String(cached.text || '')); return; }
    Promise.resolve(_fetchSnippet(q)).then((entry) => openIt(String((entry && entry.text) || ''))).catch(() => openIt(''));
  }

  // ── 结果页 ──────────────────────────────────────────────────────────
  function _renderResults() {
    const body = document.getElementById('kb-qz-body');
    const foot = document.getElementById('kb-qz-foot');
    if (!body || !foot) return;
    const summary = scoreQuiz(_state.questions, _state.answers, _state.skipped, _state.selfMark);
    body.textContent = '';
    foot.textContent = '';
    _renderProgress(summary);

    const card = document.createElement('div');
    card.className = 'kb-qz-score';
    const line = document.createElement('div');
    line.className = 'kb-qz-score-line';
    line.textContent = _tr('kb.quiz.score', `您的得分 ${summary.right}/${summary.total}`, { right: summary.right, total: summary.total });
    const pct = document.createElement('span');
    pct.className = 'kb-qz-score-pct';
    pct.textContent = `(${summary.percent}%)`;
    line.appendChild(pct);
    card.appendChild(line);

    const stats = document.createElement('div');
    stats.className = 'kb-qz-stats';
    for (const [kind, label, count] of [
      ['right', _tr('kb.quiz.stat_right', '答对'), summary.right],
      ['wrong', _tr('kb.quiz.stat_wrong', '答错'), summary.wrong],
      ['skipped', _tr('kb.quiz.stat_skipped', '跳过'), summary.skipped],
    ]) {
      const chip = document.createElement('span');
      chip.className = `kb-qz-stat is-${kind}`;
      chip.textContent = `${label} ${count}`;
      stats.appendChild(chip);
    }
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'kb-qz-textbtn kb-qz-detail-toggle';
    toggle.id = 'kb-qz-detail-toggle';
    toggle.textContent = _state.showDetail ? _tr('kb.quiz.hide_detail', '收起') : _tr('kb.quiz.show_detail', '查看');
    toggle.addEventListener('click', () => { _state.showDetail = !_state.showDetail; _renderResults(); });
    stats.appendChild(toggle);
    card.appendChild(stats);

    const unanswered = summary.total - summary.answered;
    if (unanswered > 0) {
      const note = document.createElement('div');
      note.className = 'kb-qz-score-note';
      note.textContent = _tr('kb.quiz.unanswered_note', `还有 ${unanswered} 题没作答（按跳过计入）`, { count: unanswered });
      card.appendChild(note);
    }
    body.appendChild(card);

    if (_state.showDetail) {
      const list = document.createElement('div');
      list.className = 'kb-qz-detail';
      _state.questions.forEach((q, i) => {
        const item = summary.items[i] || { status: 'skipped', given: '' };
        const row = document.createElement('div');
        row.className = 'kb-qz-detail-item is-' + item.status;
        const head = document.createElement('div');
        head.className = 'kb-qz-detail-head';
        const no = document.createElement('span');
        no.className = 'kb-qz-detail-no';
        no.textContent = `${i + 1}.`;
        const title = document.createElement('span');
        title.className = 'kb-qz-detail-q';
        title.textContent = String(q.question || '');
        const badge = document.createElement('span');
        badge.className = 'kb-qz-detail-badge';
        badge.textContent = item.status === 'right' ? _tr('kb.quiz.mark_right', '答对')
          : item.status === 'wrong' ? _tr('kb.quiz.mark_wrong', '答错') : _tr('kb.quiz.mark_skipped', '跳过');
        head.append(no, title, badge);
        row.appendChild(head);
        if (item.given) row.appendChild(_answerBlock(_tr('kb.quiz.your_answer', '你的答案'), item.given));
        row.appendChild(q.type === 'single'
          ? _answerBlock(_tr('kb.quiz.correct_answer', '正确答案'), q.answer)
          : _answerBlock(_tr('kb.quiz.reference', '参考答案'), q.answer || _tr('kb.quiz.no_reference', '（无参考答案）')));
        if (q.explain) row.appendChild(_answerBlock(_tr('kb.quiz.explain', '解析'), q.explain));
        row.appendChild(_sourceRow(q, 'detail'));
        list.appendChild(row);
      });
      body.appendChild(list);
    }

    const wrong = wrongQuestions(_state.questions, _state.answers, _state.skipped, _state.selfMark);
    if (wrong.length) {
      foot.appendChild(_footButton('kb-qz-wrong-only', _tr('kb.quiz.practice_wrong', `只练错题（${wrong.length}）`, { count: wrong.length }), () => _practiceWrong(wrong)));
    }
    if (summary.skipped > 0) {
      foot.appendChild(_footButton('kb-qz-back-skipped', _tr('kb.quiz.back_skipped', `回到跳过的题（${summary.skipped}）`, { count: summary.skipped }), () => _backToSkipped(summary)));
    }
    foot.appendChild(_footButton('kb-qz-retest', _tr('kb.quiz.retest', '再测一次'), () => _retest()));
    // 正在重新出题时置灰：出题要等本地模型，按钮必须有"在做"的样子（否则像点不动）
    const regenBtn = _footButton('kb-qz-regen', _tr('kb.quiz.regenerate', '生成后续测验'), () => _regenerate(), true);
    regenBtn.disabled = Boolean(_state.retesting);
    foot.appendChild(regenBtn);
    foot.appendChild(_footButton('kb-qz-results-close', _tr('kb.quiz.finish', '完成'), () => close()));
  }

  function _footButton(id, label, fn, primary) {
    const btn = document.createElement('button');
    btn.type = 'button';
    // 共享按钮皮肤（ui-button 系列）+ 本地布局类：与全站按钮一致，也避免自造皮肤
    btn.className = `ui-button ui-button--${primary ? 'primary' : 'secondary'} ui-button--sm kb-qz-btn`;
    btn.id = id;
    const labelEl = document.createElement('span');
    labelEl.className = 'ui-button__label';
    labelEl.textContent = label;
    btn.appendChild(labelEl);
    btn.addEventListener('click', fn);
    return btn;
  }

  /** 只练错题：用当前题库的子集重开一轮（不重新出题）。 */
  function _practiceWrong(wrong) {
    if (!_state.wrongOnly) _state.pool = _state.questions.slice();
    _state.questions = wrong.map((q) => q);
    _resetAnswers();
    _state.wrongOnly = true;
    _state.phase = 'answering';
    _saveProgress();
    _toast(_tr('kb.quiz.practice_wrong_toast', `错题重练：${wrong.length} 题`, { count: wrong.length }), { variant: 'info' });
    _render();
  }

  /** 回到跳过的题：同样是子集重开。 */
  function _backToSkipped(summary) {
    const ids = new Set(summary.items.filter((i) => i.status === 'skipped').map((i) => i.qid));
    const subset = _state.questions.filter((q) => ids.has(q.id));
    if (!subset.length) return;
    if (!_state.wrongOnly) _state.pool = _state.questions.slice();
    _state.questions = subset;
    _resetAnswers();
    _state.wrongOnly = false;
    _state.phase = 'answering';
    _saveProgress();
    _render();
  }

  function _resetAnswers() {
    _state.answers = {};
    _state.skipped = {};
    _state.selfMark = {};
    _state.submitted = {};
    _state.index = 0;
    _state.showDetail = false;
  }

  function _retest() {
    if (_state.pool && _state.pool.length) _state.questions = _state.pool.slice();
    _state.wrongOnly = false;
    _resetAnswers();
    _state.phase = 'answering';
    _saveProgress();
    _render();
    _toast(_tr('kb.quiz.retest_toast', '已清空上次作答，同一套题重新开始'), { variant: 'info' });
  }

  function _regenerate() {
    if (_state.retesting) return;
    const host = _state.host;
    if (!host || typeof host.onRegenerate !== 'function') {
      _toast(_tr('kb.quiz.regenerate_unavailable', '暂时无法生成新测验，请从知识库重新生成'), { variant: 'warning' });
      return;
    }
    _state.retesting = true;
    // 本地模型要跑 30–60 秒：当场把按钮换成禁用态，别让用户对着一个"点了没反应"的按钮
    // 反复点（重复点击原本也会被 _state.retesting 静默吞掉，读起来还是"按钮坏了"）。
    _render();
    _toast(_tr('kb.quiz.regenerating', '正在基于同一份材料生成一套新题…'), { variant: 'info' });
    Promise.resolve(host.onRegenerate()).then((payload) => {
      _state.retesting = false;
      if (!payload || !Array.isArray(payload.questions) || !payload.questions.length) {
        _toast(_tr('kb.quiz.regenerate_failed', '新题生成失败，请稍后重试'), { variant: 'warning' });
        return;
      }
      _applyPayload(payload);
      // _applyPayload 只换状态、不渲染（open() 里是它之后紧跟 _render()）。少了这一步，
      // 面板会一直停在上一轮的结果页：用户点了「生成后续测验」看不到任何变化，只会以为
      // 按钮坏了，而且每点一次都真的又打了一遍模型（真浏览器复现：calls=1 但 DOM 仍是旧结果页）。
      _render();
      const body = document.getElementById('kb-qz-body');
      if (body && body.scrollTo) body.scrollTo({ top: 0 });
      _toast(_tr('kb.quiz.regenerate_done', '新一套测验已生成'), { variant: 'success' });
    }).catch(() => {
      _state.retesting = false;
      _toast(_tr('kb.quiz.regenerate_failed', '新题生成失败，请稍后重试'), { variant: 'warning' });
    });
  }

  // ── 导出 ────────────────────────────────────────────────────────────
  function _copyQuiz() {
    const text = quizToMarkdown(_state.title, _state.questions, _state.sources);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => _toast(_tr('kb.quiz.copied', '已复制测验内容'), { variant: 'success' }))
        .catch(() => _toast(_tr('kb.quiz.copy_failed', '复制失败'), { variant: 'warning' }));
      return;
    }
    _toast(_tr('kb.quiz.copy_failed', '复制失败'), { variant: 'warning' });
  }

  /**
   * 导出 Markdown：走**主进程保存对话框**（与「导出 PDF」同一条通道）。
   *
   * 原先用渲染层 Blob + `<a download>`，并且在 a.click() 之后立刻
   * URL.revokeObjectURL —— 对象 URL 在下载真正开始前就被撤销，Chromium/Electron 里
   * 可能静默失败；而且无论成功失败都只弹一句「已导出 Markdown」，用户看到的就是
   * "点了没用、也没有报错"。改成主进程回执：取消 → 静默，失败 → 如实提示。
   */
  function _exportQuizMarkdown() {
    const text = quizToMarkdown(_state.title, _state.questions, _state.sources);
    Promise.resolve(_invoke('kb.quiz.exportMarkdown', { text, title: _state.title })).then((res) => {
      if (!res || res.canceled) return;
      if (res.ok === false) {
        _toast(_tr('kb.quiz.export_failed', '导出失败，可改用「复制测验」'), { variant: 'warning' });
        return;
      }
      _toast(_tr('kb.quiz.exported', '已导出 Markdown'), { variant: 'success' });
    }).catch(() => _toast(_tr('kb.quiz.export_failed', '导出失败，可改用「复制测验」'), { variant: 'warning' }));
  }

  /** 导出 PDF：渲染层出 A4 打印版 HTML，主进程走 printToPDF（与脑图导出同一链路）。 */
  function _exportQuizPdf() {
    const summary = scoreQuiz(_state.questions, _state.answers, _state.skipped, _state.selfMark);
    const html = quizToHtml(_state.title, _state.questions, _state.sources, {
      phase: _state.phase, right: summary.right, total: summary.total, percent: summary.percent,
    });
    Promise.resolve(_invoke('kb.quiz.exportPdf', { html, title: _state.title })).then((res) => {
      if (!res || res.canceled) return;
      if (res.ok === false) { _toast(_tr('kb.quiz.export_pdf_failed', '导出 PDF 不可用，请改用 Markdown'), { variant: 'warning' }); return; }
      _toast(_tr('kb.quiz.export_pdf_done', '已导出 PDF'), { variant: 'success' });
    }).catch(() => _toast(_tr('kb.quiz.export_pdf_failed', '导出 PDF 不可用，请改用 Markdown'), { variant: 'warning' }));
  }

  // ── 关闭与确认 ──────────────────────────────────────────────────────
  function _requestClose(reason = 'action') {
    if (reason === 'escape') {
      if (_state.menuOpen) { _state.menuOpen = false; _renderMenu(); return; }
      if (_state.sourcesOpen) { _state.sourcesOpen = false; _renderSources(); return; }
      if (_state.closeConfirm) { _state.closeConfirm = false; _render(); return; }
    }
    // 已经停在"确定关闭吗"这一屏上，再点一次 X / 遮罩 = 用户确认关闭。
    // 不能原地再渲染一次确认条：那样第二次点 X 屏幕毫无变化，用户读到的是
    // "右上角的 X 坏了"（真机反馈）。第一次点仍按防误关走确认，progress 也已
    // 自动保存，所以第二次点直接关掉不丢作答。
    if (_state.closeConfirm) { _state.closeConfirm = false; close(); return; }
    if (_hasUnfinished()) {
      _state.closeConfirm = true;
      _renderCloseConfirm();
      return;
    }
    close();
  }

  function _renderCloseConfirm() {
    const body = document.getElementById('kb-qz-body');
    const foot = document.getElementById('kb-qz-foot');
    if (!body || !foot) return;
    const done = Object.keys(_state.answers).length + Object.keys(_state.skipped).length;
    body.textContent = '';
    foot.textContent = '';
    const box = document.createElement('div');
    box.className = 'kb-qz-confirm';
    const title = document.createElement('div');
    title.className = 'kb-qz-confirm-title';
    title.textContent = _tr('kb.quiz.close_confirm_title', '这套测验还没做完，确定关闭吗？');
    const note = document.createElement('div');
    note.className = 'kb-qz-confirm-note';
    note.textContent = _tr('kb.quiz.close_confirm_note', `已作答 ${done} / ${_state.questions.length} 题；进度已自动保存，下次打开这套题可以继续。`, { done, total: _state.questions.length });
    box.append(title, note);
    body.appendChild(box);
    const keep = document.createElement('button');
    keep.type = 'button';
    keep.className = 'ui-button ui-button--primary ui-button--sm kb-qz-btn';
    keep.id = 'kb-qz-confirm-keep';
    keep.textContent = _tr('kb.quiz.close_confirm_keep', '继续答题');
    keep.addEventListener('click', () => { _state.closeConfirm = false; _render(); });
    const quit = document.createElement('button');
    quit.type = 'button';
    quit.className = 'kb-qz-textbtn';
    quit.id = 'kb-qz-confirm-quit';
    quit.textContent = _tr('kb.quiz.close_confirm_quit', '关闭（保留进度）');
    quit.addEventListener('click', () => { _state.closeConfirm = false; close(); });
    foot.append(keep, quit);
  }

  // ── 对外 API ────────────────────────────────────────────────────────
  function _applyPayload(payload) {
    const questions = Array.isArray(payload && payload.questions) ? payload.questions : [];
    _state.pool = questions.map((q) => q);
    _state.questions = questions;
    _state.sources = Array.isArray(payload && payload.sources) ? payload.sources : [];
    _state.fingerprint = String((payload && payload.fingerprint) || '');
    _state.title = String((payload && payload.title) || '') || _tr('kb.quiz.title', '测验');
    _state.dir = (payload && payload.dir) || null;
    _state.spaceId = (payload && payload.spaceId) || null;
    if (payload && payload.host) _state.host = payload.host;
    _resetAnswers();
    _state.hints = {};
    _state.hintsOpen = {};
    _state.hintLoading = {};
    _state.snippets = {};
    _state.rating = {};
    _state.edits = {};
    _state.phase = 'answering';
    _state.closeConfirm = false;
    _state.wrongOnly = false;
    _state.instant = false;
  }

  function open(payload) {
    _applyPayload(payload);
    _root();
    const restored = _loadProgress();
    const el = document.getElementById('kb-qz-overlay');
    if (_modalController) _modalController.open(document.activeElement);
    else if (el) el.hidden = false;
    _state.open = true;
    const panel = document.getElementById('kb-qz-panel');
    if (panel) panel.classList.toggle('is-max', _state.maximize);
    _render();
    if (restored) _toast(_tr('kb.quiz.progress_restored', '已恢复上次作答进度'), { variant: 'info' });
  }

  function close() {
    if (_modalController && _modalController.isOpen()) {
      _modalController.close('action');
      return;
    }
    _finishClose();
  }

  function _finishClose() {
    _hideSnippetPreview();
    const el = document.getElementById('kb-qz-overlay');
    if (el) el.hidden = true;
    _state.open = false;
    _state.menuOpen = false;
    _state.sourcesOpen = false;
    _state.closeConfirm = false;
    const menu = document.getElementById('kb-qz-menu');
    if (menu) menu.hidden = true;
    if (_state.host && typeof _state.host.onClose === 'function') {
      try { _state.host.onClose(); } catch { /* 收起失败不影响关闭 */ }
    }
  }

  function isOpen() { return _state.open; }
  function hasProgress() {
    return Object.keys(_state.answers).length > 0 || _state.phase === 'results';
  }

  window.KbQuizPanel = { open, close, isOpen, hasProgress };
  // 纯函数/文本导出：供渲染层回归测试直接用（不依赖真实 DOM 交互）
  window.__kbQuizUtils = {
    normText, isCorrect, scoreQuiz, wrongQuestions, quizToMarkdown, quizToHtml,
    typeLabel: (q) => (q && q.type === 'short' ? 'short' : 'single'),
  };
})();
