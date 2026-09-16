// ─── 知识库测验：答题 / 结果面板 — classic script (window.KbQuizPanel) ───
//
// 对标 NotebookLM Studio 的「测验」：逐题作答（可选提示/跳过）→ 提交 → 结果页
// （得分、答对/答错/跳过分类、逐题详情与原文依据）→ 再测一次 / 生成后续测验。
//
// 分工（与仓库既有约定一致）：
//   * 出题在主进程（kb.quiz），本模块只做**呈现与作答状态**，不重新出题、不改题目；
//   * 题干/选项/答案/解析一律用 textContent 写入（模型输出不拼 innerHTML）；
//   * 控件走共享原语 uiButton/uiIconButton，可见文案走 _tr（zh/en 词表）；
//   * 测不了的不假装：简答题没有自动判分能力 → 用户对照参考答案自评，如实标注；
//     提示拿不到材料线索时显示"这份材料没有直接讲到"，不编内容。
(function () {
  const _state = {
    open: false,
    questions: [],
    sources: [],
    fingerprint: '',
    title: '',
    dir: null,
    spaceId: null,
    index: 0,
    answers: {},        // qid -> 文本（单选=选项原文；简答=用户输入）
    skipped: {},        // qid -> true
    selfMark: {},       // qid -> 'right' | 'wrong'（简答题自评）
    hints: {},          // qid -> { hint, covered, source, reason? }
    hintOpen: {},
    hintLoading: {},
    rating: {},         // qid -> 'good' | 'bad'
    phase: 'answering', // answering | results
    showDetail: false,
    maximize: false,
    menuOpen: false,
    sourcesOpen: false,
    retesting: false,
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

  // ── 纯函数（可单测）：归一、判分、汇总 ────────────────────────────────
  /**
   * 比对用的归一：全角转半角 → 只保留字母/数字/中日韩字符 → 小写。
   * 选项比较对"空白与标点"不敏感（'A 选项' 与 'Ａ． 选项' 视为同一个答案），
   * 但对文字本身敏感（不会把「管理员可写」与「访客可写」判成相同）。
   */
  function normText(s) {
    return String(s == null ? '' : s)
      .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/[^\p{L}\p{N}]/gu, '')
      .toLowerCase();
  }

  /** 单选题自动判分；简答题**不自动判分**（返回 null，由用户自评）。 */
  function isCorrect(q, answer) {
    if (!q || q.type !== 'single') return null;
    const given = normText(answer);
    if (!given) return null;
    return given === normText(q.answer);
  }

  /**
   * 结果汇总：right / wrong / skipped 三类互斥且合计 = 总题数。
   *  - 跳过：用户点了「跳过」，或始终没作答；
   *  - 简答题：按用户自评（selfMark）计入对/错，**未自评的按跳过算**（不猜）。
   */
  function scoreQuiz(questions, answers, skipped, selfMark) {
    const list = Array.isArray(questions) ? questions : [];
    const items = list.map((q) => {
      const given = String((answers || {})[q.id] ?? '');
      const isSkipped = Boolean((skipped || {})[q.id]) || !given.trim();
      if (isSkipped) return { qid: q.id, status: 'skipped', given: '' };
      if (q.type === 'single') {
        return { qid: q.id, status: isCorrect(q, given) ? 'right' : 'wrong', given };
      }
      const mark = (selfMark || {})[q.id];
      if (mark === 'right') return { qid: q.id, status: 'right', given };
      if (mark === 'wrong') return { qid: q.id, status: 'wrong', given };
      return { qid: q.id, status: 'skipped', given };
    });
    const right = items.filter((i) => i.status === 'right').length;
    const wrong = items.filter((i) => i.status === 'wrong').length;
    const skippedCount = items.filter((i) => i.status === 'skipped').length;
    const total = items.length;
    return {
      total, right, wrong, skipped: skippedCount, items,
      answered: right + wrong,
      percent: total ? Math.round((right / total) * 100) : 0,
    };
  }

  /** 题型标签。 */
  function typeLabel(q) {
    return q && q.type === 'short'
      ? _tr('kb.quiz.type_short', '简答')
      : _tr('kb.quiz.type_single', '单选');
  }

  // ── DOM 骨架 ──────────────────────────────────────────────────────────
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
          <span class="kb-qz-source-chip" id="kb-qz-sources-chip"></span>
          <span class="kb-qz-head-actions">
            ${_shareButtonHtml()}
            ${_iconButtonHtml('kb-qz-max', _tr('kb.quiz.maximize', '放大'), 'maximize')}
            ${_iconButtonHtml('kb-qz-more', _tr('kb.quiz.more', '更多'), 'more-horizontal')}
            ${_iconButtonHtml('kb-qz-close', _tr('kb.quiz.close', '关闭测验'), 'x')}
          </span>
          <div class="kb-qz-menu" id="kb-qz-menu" hidden>
            <div class="kb-qz-menu-item" data-qz-menu="copy">${_iconHtml('copy', 'kb-qz-menu-icon')}<span>${_esc(_tr('kb.quiz.menu_copy', '复制测验'))}</span></div>
            <div class="kb-qz-menu-item" data-qz-menu="export">${_iconHtml('download', 'kb-qz-menu-icon')}<span>${_esc(_tr('kb.quiz.menu_export', '导出 Markdown'))}</span></div>
          </div>
          <div class="kb-qz-sources" id="kb-qz-sources" hidden></div>
        </div>
        <div class="kb-qz-body" id="kb-qz-body"></div>
        <div class="kb-qz-foot" id="kb-qz-foot"></div>
      </div>`;
    document.body.appendChild(el);
    _bindShell(el);
    return el;
  }

  function _iconHtml(name, cls) {
    if (typeof window.uiIconHtml === 'function') return window.uiIconHtml(name, cls);
    if (typeof window._icon === 'function') return window._icon(name, cls);
    return '';
  }

  // 控件一律走共享原语（shared-ui-adoption-guard 对新模块的裸控件额度是 0）：
  // 这里不做裸控件兜底：原语没加载时 shell 直接少个按钮，而不是退回手写标签。
  function _iconButtonHtml(id, label, icon) {
    if (typeof window.uiIconButton !== 'function') return '';
    return window.uiIconButton({ label, icon, className: 'kb-qz-icon-btn', attrs: { id } });
  }

  function _buttonHtml(id, label, role, icon) {
    if (typeof window.uiButton !== 'function') return '';
    return window.uiButton({ label, role: role || 'secondary', size: 'sm', ...(icon ? { icon } : {}), className: 'kb-qz-btn', attrs: { id } });
  }

  // 分享：与知识库分享一致，外部凭据未配置前如实标「待开发」（不是隐藏，也不是假弹窗）
  function _shareButtonHtml() {
    return `<span class="kb-qz-share-wrap">${_iconButtonHtml('kb-qz-share', _tr('kb.quiz.share_soon', '分享测验（待开发）'), 'share-2')}<span class="kb-qz-soon-chip">${_esc(_tr('kb.quiz.soon', '待开发'))}</span></span>`;
  }

  function _bindShell(el) {
    document.getElementById('kb-qz-close')?.addEventListener('click', close);
    document.getElementById('kb-qz-max')?.addEventListener('click', () => {
      _state.maximize = !_state.maximize;
      document.getElementById('kb-qz-panel')?.classList.toggle('is-max', _state.maximize);
    });
    document.getElementById('kb-qz-share')?.addEventListener('click', () => {
      _toast(_tr('kb.quiz.share_soon_toast', '分享测验还没做完：需要先配置分享服务，暂时不可用'), { variant: 'info' });
    });
    document.getElementById('kb-qz-more')?.addEventListener('click', (e) => {
      e.stopPropagation();
      _state.menuOpen = !_state.menuOpen;
      const menu = document.getElementById('kb-qz-menu');
      if (menu) menu.hidden = !_state.menuOpen;
    });
    document.getElementById('kb-qz-menu')?.addEventListener('click', (e) => {
      const item = e.target && e.target.closest ? e.target.closest('[data-qz-menu]') : null;
      if (!item) return;
      _state.menuOpen = false;
      const menu = document.getElementById('kb-qz-menu');
      if (menu) menu.hidden = true;
      if (item.dataset.qzMenu === 'copy') _copyQuiz();
      else if (item.dataset.qzMenu === 'export') _exportQuizMarkdown();
    });
    const sourcesChip = document.getElementById('kb-qz-sources-chip');
    const toggleSources = (e) => {
      e.stopPropagation();
      _state.sourcesOpen = !_state.sourcesOpen;
      _renderSources();
    };
    sourcesChip?.addEventListener('click', toggleSources);
    // chip 是 span[role=button]：键盘也要能开（Enter / Space）
    sourcesChip?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') toggleSources(e);
    });
    // 点空白处收起弹层（菜单/来源列表）
    el.addEventListener('click', (e) => {
      if (e.target === el) { close(); return; }
      if (!e.target.closest || !e.target.closest('.kb-qz-menu') && !e.target.closest('#kb-qz-more')) {
        _state.menuOpen = false;
        const menu = document.getElementById('kb-qz-menu');
        if (menu) menu.hidden = true;
      }
      if (!e.target.closest || (!e.target.closest('#kb-qz-sources') && !e.target.closest('#kb-qz-sources-chip'))) {
        _state.sourcesOpen = false;
        _renderSources();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (!_state.open) return;
      if (e.key === 'Escape') {
        if (_state.menuOpen) { _state.menuOpen = false; const m = document.getElementById('kb-qz-menu'); if (m) m.hidden = true; return; }
        if (_state.sourcesOpen) { _state.sourcesOpen = false; _renderSources(); return; }
        close();
      }
    });
    // 动态渲染的模块必须跟着语言切换重刷（契约：window 的 i18n-change）
    window.addEventListener('i18n-change', () => { if (_state.open) _render(); });
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────
  function _render() {
    const el = document.getElementById('kb-qz-overlay');
    if (!el) return;
    const titleEl = document.getElementById('kb-qz-title-text');
    if (titleEl) titleEl.textContent = _state.title || _tr('kb.quiz.title', '测验');
    _renderSources();
    if (_state.phase === 'results') { _renderResults(); return; }
    _renderQuestion();
  }

  function _renderSources() {
    const chip = document.getElementById('kb-qz-sources-chip');
    const box = document.getElementById('kb-qz-sources');
    const list = Array.isArray(_state.sources) ? _state.sources : [];
    if (chip) {
      chip.hidden = !list.length;
      // 「查看 N 个来源」：与 NotebookLM 一致，直接告诉用户题目只来自这几份材料
      chip.textContent = _tr('kb.quiz.view_sources', `查看 ${list.length} 个来源`, { count: list.length });
      chip.setAttribute('role', 'button');
      chip.setAttribute('tabindex', '0');
      chip.setAttribute('aria-expanded', String(_state.sourcesOpen));
    }
    if (!box) return;
    box.hidden = !(_state.sourcesOpen && list.length);
    if (box.hidden) { box.textContent = ''; return; }
    box.textContent = '';
    for (const src of list) {
      const row = document.createElement('div');
      row.className = 'kb-qz-source-row';
      row.setAttribute('data-qz-source', src);
      row.textContent = src;
      row.addEventListener('click', () => { _openSource(src); });
      box.appendChild(row);
    }
  }

  function _current() {
    return _state.questions[_state.index] || null;
  }

  function _renderQuestion() {
    const body = document.getElementById('kb-qz-body');
    const foot = document.getElementById('kb-qz-foot');
    const q = _current();
    if (!body || !foot || !q) return;
    body.textContent = '';
    foot.textContent = '';

    const meta = document.createElement('div');
    meta.className = 'kb-qz-meta';
    meta.textContent = _tr('kb.quiz.progress', `第 ${_state.index + 1} / ${_state.questions.length} 题`, {
      current: _state.index + 1, total: _state.questions.length,
    }) + ' · ' + typeLabel(q);
    body.appendChild(meta);

    const qText = document.createElement('div');
    qText.className = 'kb-qz-question';
    qText.textContent = String(q.question || '');
    body.appendChild(qText);

    if (q.type === 'single') {
      const list = document.createElement('div');
      list.className = 'kb-qz-options';
      const given = String(_state.answers[q.id] || '');
      q.options.forEach((opt, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'kb-qz-option' + (normText(opt) === normText(given) ? ' is-selected' : '');
        btn.setAttribute('data-qz-option', String(i));
        const badge = document.createElement('span');
        badge.className = 'kb-qz-option-letter';
        badge.textContent = String.fromCharCode(65 + i);
        const text = document.createElement('span');
        text.className = 'kb-qz-option-text';
        text.textContent = String(opt);
        btn.append(badge, text);
        btn.addEventListener('click', () => {
          _state.answers[q.id] = String(opt);
          delete _state.skipped[q.id];
          _renderQuestion();
        });
        list.appendChild(btn);
      });
      body.appendChild(list);
    } else {
      const ta = document.createElement('textarea');
      ta.className = 'kb-qz-short-input';
      ta.id = 'kb-qz-short-input';
      ta.rows = 3;
      ta.placeholder = _tr('kb.quiz.short_placeholder', '写下你的答案（简答题由你自己对照参考答案判定）');
      ta.value = String(_state.answers[q.id] || '');
      ta.addEventListener('input', () => { _state.answers[q.id] = ta.value; });
      body.appendChild(ta);
    }

    // 简答：给过自评后，把参考答案与自评结果就地展示（不自动判分，如实标注）
    const mark = _state.selfMark[q.id];
    if (q.type === 'short' && mark) {
      const box = document.createElement('div');
      box.className = 'kb-qz-selfcheck' + (mark === 'right' ? ' is-right' : ' is-wrong');
      const head = document.createElement('div');
      head.className = 'kb-qz-selfcheck-head';
      head.textContent = mark === 'right'
        ? _tr('kb.quiz.self_right', '已记为答对（你自己对照后判定）')
        : _tr('kb.quiz.self_wrong', '已记为答错（你自己对照后判定）');
      box.appendChild(head);
      box.appendChild(_answerBlock(_tr('kb.quiz.reference', '参考答案'), q.answer || _tr('kb.quiz.no_reference', '（无参考答案）')));
      if (q.explain) box.appendChild(_answerBlock(_tr('kb.quiz.explain', '解析'), q.explain));
      body.appendChild(box);
    }

    // 提示区（点击才请求；模型给不出来就如实说明）
    const hint = _state.hints[q.id];
    if (_state.hintOpen[q.id] && hint) {
      const box = document.createElement('div');
      box.className = 'kb-qz-hint';
      const tag = document.createElement('span');
      tag.className = 'kb-qz-hint-tag';
      tag.textContent = hint.covered ? _tr('kb.quiz.hint_tag', '线索') : _tr('kb.quiz.hint_tag_none', '材料未覆盖');
      const text = document.createElement('span');
      text.className = 'kb-qz-hint-text';
      text.textContent = hint.hint || _tr('kb.quiz.hint_empty', '暂时拿不到提示，请稍后重试');
      box.append(tag, text);
      body.appendChild(box);
    }

    // 原文依据：题目来源文档（有则可点，直接打开那份材料）
    if (q.source) {
      const src = document.createElement('div');
      src.className = 'kb-qz-qsource';
      const label = document.createElement('span');
      label.className = 'kb-qz-qsource-label';
      label.textContent = _tr('kb.quiz.q_source', '原文依据');
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'kb-qz-qsource-link';
      link.textContent = String(q.source);
      link.addEventListener('click', () => _openSource(String(q.source)));
      src.append(label, link);
      body.appendChild(src);
    }

    // ── 底部：提示 / 跳过 / 下一个（简答需先自评）+ 评分 ──
    const hintBtn = document.createElement('button');
    hintBtn.type = 'button';
    hintBtn.className = 'kb-qz-btn kb-qz-hint-btn';
    hintBtn.id = 'kb-qz-hint';
    hintBtn.disabled = Boolean(_state.hintLoading[q.id]);
    hintBtn.textContent = _state.hintLoading[q.id]
      ? _tr('kb.quiz.hint_loading', '正在找线索…')
      : (_state.hintOpen[q.id] ? _tr('kb.quiz.hint_hide', '收起提示') : _tr('kb.quiz.hint', '提示'));
    hintBtn.addEventListener('click', () => _toggleHint(q));
    foot.appendChild(hintBtn);

    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'kb-qz-btn kb-qz-skip-btn';
    skipBtn.id = 'kb-qz-skip';
    skipBtn.textContent = _tr('kb.quiz.skip', '跳过');
    skipBtn.addEventListener('click', () => {
      _state.skipped[q.id] = true;
      delete _state.answers[q.id];
      _advance();
    });
    foot.appendChild(skipBtn);

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'kb-qz-btn is-primary';
    nextBtn.id = 'kb-qz-next';
    const last = _state.index >= _state.questions.length - 1;
    nextBtn.textContent = last ? _tr('kb.quiz.see_results', '查看结果') : _tr('kb.quiz.next', '下一个');
    nextBtn.addEventListener('click', () => _submitCurrent());
    foot.appendChild(nextBtn);

    // 简答：提交后先自评（「我答对了 / 没答对」），自评完按钮才变「下一题」
    if (q.type === 'short' && !mark) {
      const given = String(_state.answers[q.id] || '').trim();
      if (given) {
        const selfBox = document.createElement('span');
        selfBox.className = 'kb-qz-selfmark';
        selfBox.append(
          _selfMarkButton('right', q),
          _selfMarkButton('wrong', q),
        );
        foot.appendChild(selfBox);
      }
    }

    foot.appendChild(_ratingHtml(q));
  }

  function _selfMarkButton(kind, q) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'kb-qz-btn kb-qz-selfmark-btn' + (kind === 'right' ? ' is-right' : ' is-wrong');
    btn.id = kind === 'right' ? 'kb-qz-self-right' : 'kb-qz-self-wrong';
    btn.textContent = kind === 'right' ? _tr('kb.quiz.self_mark_right', '我答对了') : _tr('kb.quiz.self_mark_wrong', '没答对');
    btn.addEventListener('click', () => {
      _state.selfMark[q.id] = kind;
      _state.phase = 'answering';
      // 自评完立刻进入结果页（最后一题）或下一题
      const last = _state.index >= _state.questions.length - 1;
      if (last) _showResults();
      else { _state.index += 1; _renderQuestion(); }
    });
    return btn;
  }

  /** 评分（优质 / 劣质）：只记本机台账；点了就显示出已评分状态，不重复记。 */
  function _ratingHtml(q) {
    const wrap = document.createElement('span');
    wrap.className = 'kb-qz-rating';
    const current = _state.rating[q.id];
    for (const [kind, label] of [['good', _tr('kb.quiz.rate_good', '优质内容')], ['bad', _tr('kb.quiz.rate_bad', '劣质内容')]]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'kb-qz-rate-btn' + (current === kind ? ' is-active' : '');
      btn.setAttribute('data-qz-rate', kind);
      btn.textContent = label;
      btn.addEventListener('click', () => _rate(q, kind));
      wrap.appendChild(btn);
    }
    return wrap;
  }

  function _rate(q, verdict) {
    // 只有**真的记上了**才说"已记录"：拿不到通道 / 通道报错都如实说没记上，
    // 并且把按钮的选中态撤回（否则界面在骗人）。
    const invoke = window.cogseed && window.cogseed.invoke;
    const correct = q.type === 'single' ? isCorrect(q, _state.answers[q.id]) : (_state.selfMark[q.id] === 'right' ? true : null);
    const fail = () => {
      delete _state.rating[q.id];
      _toast(_tr('kb.quiz.rate_failed', '评分没记上，请稍后重试'), { variant: 'warning' });
      if (_state.phase === 'answering') _renderQuestion(); else _renderResults();
    };
    if (typeof invoke !== 'function') { fail(); return; }
    _state.rating[q.id] = verdict;
    if (_state.phase === 'answering') _renderQuestion(); else _renderResults();
    Promise.resolve(invoke('kb.quiz.feedback', {
      fingerprint: _state.fingerprint, qid: q.id, verdict,
      type: q.type, source: q.source || '', ...(correct === null ? {} : { correct }),
    })).then((res) => {
      if (!res || res.ok === false) { fail(); return; }
      _toast(verdict === 'good' ? _tr('kb.quiz.rate_thanks', '已记录：优质内容') : _tr('kb.quiz.rate_thanks_bad', '已记录：劣质内容'), { variant: 'success' });
    }).catch(fail);
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

  /** 多要点参考答案/解析按「；」等分隔成条目（复用 kb-workbench 的同一个纯函数）。 */
  function _clauses(text) {
    const utils = window.__kbFvUtils;
    if (utils && typeof utils.quizAnswerClauses === 'function') return utils.quizAnswerClauses(text);
    return String(text || '').split(/[\n；;]/).map((s) => s.trim()).filter(Boolean);
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
      // 简答题：不自动判分，先让用户对照参考答案自评（按钮出现在底部）
      _renderQuestion();
      _toast(_tr('kb.quiz.short_self_mark', '对照参考答案后，点「我答对了 / 没答对」'), { variant: 'info' });
      return;
    }
    _advance();
  }

  function _advance() {
    if (_state.index >= _state.questions.length - 1) { _showResults(); return; }
    _state.index += 1;
    _renderQuestion();
    const body = document.getElementById('kb-qz-body');
    if (body && body.scrollTo) body.scrollTo({ top: 0 });
  }

  function _showResults() {
    _state.phase = 'results';
    _renderResults();
  }

  function _renderResults() {
    const body = document.getElementById('kb-qz-body');
    const foot = document.getElementById('kb-qz-foot');
    if (!body || !foot) return;
    const summary = scoreQuiz(_state.questions, _state.answers, _state.skipped, _state.selfMark);
    body.textContent = '';
    foot.textContent = '';

    const card = document.createElement('div');
    card.className = 'kb-qz-score';
    const scoreLine = document.createElement('div');
    scoreLine.className = 'kb-qz-score-line';
    scoreLine.textContent = _tr('kb.quiz.score', `您的得分 ${summary.right}/${summary.total}`, { right: summary.right, total: summary.total });
    const pct = document.createElement('span');
    pct.className = 'kb-qz-score-pct';
    pct.textContent = `(${summary.percent}%)`;
    scoreLine.appendChild(pct);
    card.appendChild(scoreLine);

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
    toggle.className = 'kb-qz-btn kb-qz-detail-toggle';
    toggle.id = 'kb-qz-detail-toggle';
    toggle.textContent = _state.showDetail ? _tr('kb.quiz.hide_detail', '收起') : _tr('kb.quiz.show_detail', '查看');
    toggle.addEventListener('click', () => {
      _state.showDetail = !_state.showDetail;
      _renderResults();
    });
    stats.appendChild(toggle);
    card.appendChild(stats);
    if (summary.total && summary.answered < summary.total) {
      const note = document.createElement('div');
      note.className = 'kb-qz-score-note';
      note.textContent = _tr('kb.quiz.unanswered_note', `还有 ${summary.total - summary.answered} 题没作答（按跳过计入）`, { count: summary.total - summary.answered });
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
        if (q.type === 'single') row.appendChild(_answerBlock(_tr('kb.quiz.correct_answer', '正确答案'), q.answer));
        else row.appendChild(_answerBlock(_tr('kb.quiz.reference', '参考答案'), q.answer || _tr('kb.quiz.no_reference', '（无参考答案）')));
        if (q.explain) row.appendChild(_answerBlock(_tr('kb.quiz.explain', '解析'), q.explain));
        if (q.source) {
          const src = document.createElement('div');
          src.className = 'kb-qz-qsource';
          const label = document.createElement('span');
          label.className = 'kb-qz-qsource-label';
          label.textContent = _tr('kb.quiz.q_source', '原文依据');
          const link = document.createElement('button');
          link.type = 'button';
          link.className = 'kb-qz-qsource-link';
          link.textContent = String(q.source);
          link.addEventListener('click', () => _openSource(String(q.source)));
          src.append(label, link);
          row.appendChild(src);
        }
        list.appendChild(row);
      });
      body.appendChild(list);
    }

    foot.appendChild(_footButton('kb-qz-retest', _tr('kb.quiz.retest', '再测一次'), () => _retest()));
    foot.appendChild(_footButton('kb-qz-regen', _tr('kb.quiz.regenerate', '生成后续测验'), () => _regenerate(), true));
    foot.appendChild(_footButton('kb-qz-results-close', _tr('kb.quiz.finish', '完成'), () => close()));
  }

  function _footButton(id, label, fn, primary) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'kb-qz-btn' + (primary ? ' is-primary' : '');
    btn.id = id;
    btn.textContent = label;
    btn.addEventListener('click', fn);
    return btn;
  }

  // ── 动作 ──────────────────────────────────────────────────────────────
  function _retest() {
    // 「再测一次」= 清空答题记录，重跑同一套题（题目本身不重新生成）
    _state.answers = {};
    _state.skipped = {};
    _state.selfMark = {};
    _state.index = 0;
    _state.showDetail = false;
    _state.phase = 'answering';
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
    _toast(_tr('kb.quiz.regenerating', '正在基于同一份材料生成一套新题…'), { variant: 'info' });
    Promise.resolve(host.onRegenerate()).then((payload) => {
      _state.retesting = false;
      if (!payload || !Array.isArray(payload.questions) || !payload.questions.length) {
        _toast(_tr('kb.quiz.regenerate_failed', '新题生成失败，请稍后重试'), { variant: 'warning' });
        return;
      }
      _applyPayload(payload);
      _toast(_tr('kb.quiz.regenerate_done', '新一套测验已生成'), { variant: 'success' });
    }).catch(() => {
      _state.retesting = false;
      _toast(_tr('kb.quiz.regenerate_failed', '新题生成失败，请稍后重试'), { variant: 'warning' });
    });
  }

  function _toggleHint(q) {
    if (_state.hintOpen[q.id]) { _state.hintOpen[q.id] = false; _renderQuestion(); return; }
    if (_state.hints[q.id]) { _state.hintOpen[q.id] = true; _renderQuestion(); return; }
    if (_state.hintLoading[q.id]) return;
    _state.hintLoading[q.id] = true;
    _renderQuestion();
    const invoke = window.cogseed && window.cogseed.invoke;
    Promise.resolve(invoke ? invoke('kb.quiz.hint', {
      question: q.question,
      options: q.options || [],
      type: q.type,
      source: q.source || '',
      dir: _state.dir,
      spaceId: _state.spaceId,
      fingerprint: _state.fingerprint,
      qid: q.id,
    }) : null).then((res) => {
      _state.hintLoading[q.id] = false;
      const hint = res && typeof res.hint === 'string' && res.hint.trim() ? res.hint : '';
      if (!hint) {
        _state.hints[q.id] = { hint: _tr('kb.quiz.hint_empty', '暂时拿不到提示，请稍后重试'), covered: false };
      } else {
        _state.hints[q.id] = { hint, covered: res.covered !== false };
      }
      _state.hintOpen[q.id] = true;
      _renderQuestion();
    }).catch(() => {
      _state.hintLoading[q.id] = false;
      _state.hints[q.id] = { hint: _tr('kb.quiz.hint_empty', '暂时拿不到提示，请稍后重试'), covered: false };
      _state.hintOpen[q.id] = true;
      _renderQuestion();
    });
  }

  function _openSource(pathText) {
    const host = _state.host;
    if (host && typeof host.onOpenSource === 'function' && host.onOpenSource(pathText) !== false) return;
    _toast(_tr('kb.quiz.source_open_failed', '打不开这份来源文档（可能已被移动或删除）'), { variant: 'warning' });
  }

  /** 测验纯文本（复制/导出用）：题干 + 选项 + 答案 + 解析 + 来源。 */
  function quizToMarkdown(title, questions, sources) {
    const lines = [`# ${title || _tr('kb.quiz.title', '测验')}`, ''];
    if (Array.isArray(sources) && sources.length) {
      lines.push(`${_tr('kb.quiz.md_sources', '来源')}: ${sources.join('、')}`, '');
    }
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

  function _exportQuizMarkdown() {
    const md = quizToMarkdown(_state.title, _state.questions, _state.sources);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(_state.title || 'quiz').replace(/[\\/:*?"<>|\s]+/g, '-')}-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
    _toast(_tr('kb.quiz.exported', '已导出 Markdown'), { variant: 'success' });
  }

  // ── 对外 API ──────────────────────────────────────────────────────────
  function _applyPayload(payload) {
    _state.questions = Array.isArray(payload && payload.questions) ? payload.questions : [];
    _state.sources = Array.isArray(payload && payload.sources) ? payload.sources : [];
    _state.fingerprint = String((payload && payload.fingerprint) || '');
    _state.title = String((payload && payload.title) || '') || _tr('kb.quiz.title', '测验');
    _state.dir = (payload && payload.dir) || null;
    _state.spaceId = (payload && payload.spaceId) || null;
    if (payload && payload.host) _state.host = payload.host;
    _state.index = 0;
    _state.answers = {};
    _state.skipped = {};
    _state.selfMark = {};
    _state.hints = {};
    _state.hintOpen = {};
    _state.hintLoading = {};
    _state.rating = {};
    _state.phase = 'answering';
    _state.showDetail = false;
  }

  function open(payload) {
    _applyPayload(payload);
    _root();
    const el = document.getElementById('kb-qz-overlay');
    if (el) el.hidden = false;
    _state.open = true;
    const panel = document.getElementById('kb-qz-panel');
    if (panel) panel.classList.toggle('is-max', _state.maximize);
    _render();
  }

  function close() {
    const el = document.getElementById('kb-qz-overlay');
    if (el) el.hidden = true;
    _state.open = false;
    _state.menuOpen = false;
    _state.sourcesOpen = false;
    const menu = document.getElementById('kb-qz-menu');
    if (menu) menu.hidden = true;
    if (_state.host && typeof _state.host.onClose === 'function') {
      try { _state.host.onClose(); } catch { /* 收起失败不影响关闭 */ }
    }
  }

  function isOpen() { return _state.open; }

  /** 供 kb-workbench 的缩略卡展示用：当前是否已答过题（有作答记录）。 */
  function hasProgress() {
    return Object.keys(_state.answers).length > 0 || _state.phase === 'results';
  }

  window.KbQuizPanel = { open, close, isOpen, hasProgress };
  // 纯函数/文本导出：供渲染层回归测试直接用（不依赖真实 DOM 交互）
  window.__kbQuizUtils = { normText, isCorrect, scoreQuiz, quizToMarkdown, typeLabel: (q) => (q && q.type === 'short' ? 'short' : 'single') };
})();
