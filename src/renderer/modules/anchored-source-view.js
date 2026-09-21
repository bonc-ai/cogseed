/**
 * Shared source viewer for knowledge-base files and citation anchors.
 *
 * The compact view resolves and highlights a cited chunk. The reader view
 * lazily asks the same read-only resolver for a bounded document payload, so
 * opening a file never writes data or triggers rich-document extraction.
 */
(function initAnchoredSourceView(root) {
  'use strict';

  const log = typeof createLogger === 'function' ? createLogger('anchored-source-view') : null;
  let activeModal = null;
  let activeAnchor = null;
  let activeView = 'anchor';
  let activeResult = null;
  let requestSequence = 0;
  /**
   * md 文档的正文形态：false = 排版阅读（默认，给人读），true = 原文源码
   * （给机器读，但字符偏移精确高亮只有在原文里才成立）。每打开一份文档重置。
   */
  let mdSourceMode = false;
  // 转写纠错面板（宿主 A）：只在"阅读全文"且拿到文本时可用；原文只读。
  let activeCorrection = null;
  let correctionOpen = false;

  function formatFallback(text, vars) {
    return String(text || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => String(vars?.[key] ?? ''));
  }

  function t(key, fallback, vars) {
    try {
      const value = typeof root.t === 'function' ? root.t(key, vars || {}) : '';
      return value && value !== key ? value : formatFallback(fallback, vars);
    } catch (_) {
      return formatFallback(fallback, vars);
    }
  }

  function viewerBodyHtml() {
    return [
      '<div class="anchored-source-viewer">',
      // 左列：工具栏 + 正文；右列：纠错面板（打开时才出现）。
      // 拆成 main 包装层是为了让"并排"成立——否则 aside 会堆到正文下方。
      '<div class="anchored-source-main">',
      '<div class="anchored-source-toolbar">',
      '<div class="anchored-source-meta" data-anchor-view-meta></div>',
      '<div class="anchored-source-actions" data-anchor-view-actions></div>',
      '</div>',
      '<div class="anchored-source-body">',
      '<div class="anchored-source-status" data-anchor-view-status></div>',
      '<pre class="anchored-source-text" data-anchor-view-text></pre>',
      '<div class="anchored-source-note" data-anchor-view-note hidden></div>',
      '</div>',
      '</div>',
      // 左右之间的可拖拽分隔符（真机反馈：没有分割符就只能吃默认比例）
      '<div class="anchored-source-splitter" data-anchor-view-split hidden role="separator"'
      + ' aria-orientation="vertical" tabindex="0" data-anchor-view-split-handle></div>',
      '<aside class="anchored-source-correct" data-anchor-view-correct hidden></aside>',
      '</div>',
    ].join('');
  }

  function modalIsOpen() {
    return Boolean(activeModal?.overlay && document.body.contains(activeModal.overlay));
  }

  function ensureModal() {
    if (modalIsOpen()) return activeModal;
    if (typeof root.uiModal !== 'function' || typeof root.uiButton !== 'function') return null;

    const modal = root.uiModal({
      title: t('kb.viewer.title', '原文查看器'),
      description: t('kb.viewer.description', '查看知识库原文，并定位到引用片段。'),
      closeLabel: t('common.close', '关闭'),
      size: 'lg',
      bodyHtml: viewerBodyHtml(),
    });
    modal.dialog.classList.add('anchored-source-modal');
    // Keep the reader's corner close control independent of the modal-shell
    // click delegation, because the document surface can be scrollable.
    modal.dialog.querySelector('[data-ui-modal-close]')?.addEventListener('click', () => {
      modal.close(null, 'close');
    });
    modal.then(() => {
      // 关闭查看器时销毁纠错面板（其内部状态随 run 走，不跨文档复用）。
      destroyCorrection();
      if (activeModal === modal) activeModal = null;
    });
    activeModal = modal;
    applyReaderScale(readReaderScale());
    return modal;
  }

  function element(selector) {
    return activeModal?.dialog?.querySelector(selector) || null;
  }

  function setMeta(text) {
    const meta = element('[data-anchor-view-meta]');
    if (meta) meta.textContent = text;
  }

  function setStatus(text, tone) {
    const status = element('[data-anchor-view-status]');
    if (!status) return;
    status.textContent = text || '';
    status.hidden = !text;
    status.dataset.tone = tone || '';
  }

  function renderActions() {
    const host = element('[data-anchor-view-actions]');
    if (!host) return;
    const canReturnToAnchor = activeView === 'document'
      && activeAnchor
      && (Number.isFinite(Number(activeAnchor.chunkIdx)) || String(activeAnchor.quote || '').trim());
    const label = activeView === 'anchor'
      ? t('kb.viewer.read_full', '阅读全文')
      : canReturnToAnchor
        ? t('kb.viewer.back_to_anchor', '返回引用位置')
        : '';
    const buttons = [];
    if (label) {
      buttons.push(root.uiButton({
        label,
        icon: activeView === 'anchor' ? 'book-open' : 'quote',
        role: 'secondary',
        size: 'sm',
        attrs: { 'data-anchor-view-toggle': 'true' },
      }));
    }
    // md 文档：排版阅读 ⇄ 原文源码。默认排版（给人读），想看 `#`/`**` 原文或
    // 需要按字符偏移精确核对引用时切到源码——两种能力都留着，不二选一。
    if (canRenderMarkdown()) {
      const mdSourceKey = mdSourceMode ? 'kb.viewer.md_rendered' : 'kb.viewer.md_source';
      buttons.push(root.uiButton({
        label: mdSourceMode
          ? t('kb.viewer.md_rendered', '看排版')
          : t('kb.viewer.md_source', '查看源码'),
        icon: mdSourceMode ? 'file-text' : 'code',
        role: mdSourceMode ? 'primary' : 'secondary',
        size: 'sm',
        attrs: { 'data-anchor-view-md-source': 'true', 'data-i18n': mdSourceKey },
      }));
    }
    if (canCorrect()) {
      buttons.push(root.uiButton({
        label: correctionOpen
          ? t('kb.transcriptCorrect.close_panel', '收起纠错')
          : t('kb.transcriptCorrect.title', '转写纠错'),
        icon: 'clipboard-list',
        role: correctionOpen ? 'primary' : 'secondary',
        size: 'sm',
        attrs: { 'data-anchor-view-correct-toggle': 'true' },
      }));
    }
    // 阅读字号三档（规范 §五-3）：只在"阅读全文"时给，图标+文字与其它工具按钮同款
    if (activeView === 'document') {
      const current = readReaderScale();
      for (const [scale, label, key] of [
        ['s', t('kb.viewer.scale_s', '小'), 'kb.viewer.scale_s'],
        ['m', t('kb.viewer.scale_m', '中'), 'kb.viewer.scale_m'],
        ['l', t('kb.viewer.scale_l', '大'), 'kb.viewer.scale_l'],
      ]) {
        buttons.push(root.uiButton({
          label,
          role: current === scale ? 'primary' : 'ghost',
          size: 'sm',
          attrs: { 'data-anchor-view-scale': scale, 'data-i18n': key },
        }));
      }
    }
    host.innerHTML = buttons.join('');
    host.querySelector('[data-anchor-view-toggle]')?.addEventListener('click', () => {
      void loadView(activeView === 'anchor' ? 'document' : 'anchor');
    });
    for (const node of host.querySelectorAll('[data-anchor-view-scale]')) {
      node.addEventListener('click', () => {
        applyReaderScale(node.getAttribute('data-anchor-view-scale'));
        renderActions();
      });
    }
    host.querySelector('[data-anchor-view-correct-toggle]')?.addEventListener('click', () => {
      void toggleCorrection();
    });
    host.querySelector('[data-anchor-view-md-source]')?.addEventListener('click', () => {
      mdSourceMode = !mdSourceMode;
      // 正文形态一变就重画正文（不重新取文档：内容本来就在手上）
      if (activeResult) renderText(activeResult);
      renderActions();
    });
  }

  /**
   * 右栏宽度（视觉反馈：左右之间要能拖）。
   *   - 指针拖拽：`pointerdown/move/up`，夹在 [MIN, MAX] 内，按容器宽度动态上限；
   *   - 键盘：←/→ 每次 16px，Home/Enter 回到默认 40%；
   *   - 持久化：本机 localStorage（下次打开还是这个宽度）；
   *   - 双击 / 双击分隔符：复位到默认比例。
   */
  const SPLIT_MIN_PX = 280;
  const SPLIT_MAX_PX = 760;
  const SPLIT_STEP_PX = 16;
  const SPLIT_KEY = 'cogseed.readerSplitWidth';

  function readSplitWidth() {
    try {
      const saved = Number(root.localStorage?.getItem?.(SPLIT_KEY));
      return Number.isFinite(saved) && saved > 0 ? saved : 0;
    } catch (_) {
      return 0;
    }
  }

  function clampSplitWidth(width, containerWidth) {
    // 上限取三者最小：绝对上限、容器的 62%、以及"左栏至少留 240px"——
    // 不然窄窗口下右栏会把阅读区挤到 200px 出头，读不下去。
    // 左栏（含工具栏内边距）至少留 300px，不然阅读区只剩两百出头，读不下去
    const keepReading = Math.max(SPLIT_MIN_PX, Math.floor((containerWidth || 0) - 300));
    const dynamicMax = Math.max(
      SPLIT_MIN_PX,
      Math.min(SPLIT_MAX_PX, Math.floor((containerWidth || 0) * 0.62), keepReading),
    );
    return Math.max(SPLIT_MIN_PX, Math.min(Math.round(width), dynamicMax));
  }

  function applySplitWidth(width, options = {}) {
    const viewer = element('.anchored-source-viewer');
    const aside = element('[data-anchor-view-correct]');
    if (!viewer || !aside) return 0;
    const containerWidth = viewer.getBoundingClientRect?.().width || viewer.clientWidth || 0;
    const value = clampSplitWidth(width || containerWidth * 0.4, containerWidth);
    aside.style.flexBasis = `${value}px`;
    aside.style.maxWidth = `${value}px`;
    aside.style.minWidth = `${Math.min(SPLIT_MIN_PX, value)}px`;
    if (options.persist !== false) {
      try { root.localStorage?.setItem?.(SPLIT_KEY, String(value)); } catch (_) { /* 存偏好失败不影响布局 */ }
    }
    return value;
  }

  function beginSplitDrag(event) {
    const viewer = element('.anchored-source-viewer');
    const handle = element('[data-anchor-view-split]');
    if (!viewer || !handle) return;
    event.preventDefault?.();
    const rect = viewer.getBoundingClientRect?.() || { right: 0, width: 0 };
    const move = (moveEvent) => {
      const clientX = moveEvent.clientX ?? 0;
      applySplitWidth(rect.right - clientX, { persist: false });
    };
    const finish = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', finish);
      const aside = element('[data-anchor-view-correct]');
      const current = aside ? Number.parseFloat(aside.style.flexBasis || '0') : 0;
      if (current > 0) applySplitWidth(current);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', finish);
    handle.setPointerCapture?.(event.pointerId);
  }

  function onSplitKeydown(event) {
    const viewer = element('.anchored-source-viewer');
    const aside = element('[data-anchor-view-correct]');
    if (!viewer || !aside) return;
    const current = Number.parseFloat(aside.style.flexBasis || '0')
      || (viewer.getBoundingClientRect?.().width || 0) * 0.4;
    if (event.key === 'ArrowLeft') {
      event.preventDefault?.();
      applySplitWidth(current - SPLIT_STEP_PX);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault?.();
      applySplitWidth(current + SPLIT_STEP_PX);
    } else if (event.key === 'Enter' || event.key === ' ' || event.key === 'Home') {
      event.preventDefault?.();
      applySplitWidth((viewer.getBoundingClientRect?.().width || 0) * 0.4);
    }
  }

  function bindSplitter() {
    const handle = element('[data-anchor-view-split-handle]');
    if (!handle || handle.dataset.bound === '1') return;
    handle.dataset.bound = '1';
    handle.addEventListener('pointerdown', beginSplitDrag);
    handle.addEventListener('keydown', onSplitKeydown);
    handle.addEventListener('dblclick', () => {
      const viewer = element('.anchored-source-viewer');
      applySplitWidth((viewer?.getBoundingClientRect?.().width || 0) * 0.4);
    });
  }

  // ── 排版类文件：一律不进纯文本阅读器 ───────────────────────────────────
  /**
   * 「保排版」类型：PDF / Office / HTML / 图片 / 音视频。
   *
   * 为什么这份清单放在这里：它是**富查看器分派的唯一来源**。阅读器
   * （本文件的纯文本视图）与富查看器（懒加载的 kb-workbench）各写一份
   * 扩展名表会漂移——一边当排版类、另一边当纯文本，文件就被"降级成
   * 没有排版的字符流"（真机反馈「word、pdf 等无法正常查看」就是这个）。
   * kb-workbench 反过来读 `__kbRichPreviewExts` / `__kbIsRichPath`。
   */
  const RICH_PREVIEW_EXTS = new Set([
    '.pdf', '.docx', '.docm', '.xlsx', '.xlsm', '.pptx', '.pptm',
    '.html', '.htm',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif',
    '.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac', '.mp4', '.mov', '.webm', '.mkv', '.avi',
  ]);

  function richExtOf(relPath) {
    const name = String(relPath || '').split(/[\\/]/).pop() || '';
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot).toLowerCase() : '';
  }

  /** 该路径是否该走"保排版"的富查看器（纯文本返回 false）。 */
  function isRichPreviewPath(relPath) {
    return RICH_PREVIEW_EXTS.has(richExtOf(relPath));
  }

  root.__kbRichPreviewExts = RICH_PREVIEW_EXTS;
  root.__kbIsRichPath = isRichPreviewPath;

  // ── Markdown 文档：正文排版化（给人读），不再直出原文（给机器读） ──────
  /**
   * `.md / .markdown` **不进**富查看器——它要留住阅读器的两个能力：引用高亮、
   * 转写纠错面板（见上方 RICH_PREVIEW_EXTS 注释）。但正文必须排版化：此前
   * 是把原文直接塞进 `<pre>`，用户看到的是 `# 标题`、`**加粗**`、`| 表 |`、
   * `` `代码` `` 这些"给机器读"的记号（真机反馈：「知识库里打开 md 还是机器
   * 格式」）。现在改走 utils.js 的统一 markdown 管线（`renderMarkdown`，
   * 自带 sanitize / 代码块 / 表格 / 数学保护），与聊天侧 md 预览同一套排版。
   *
   * 只对「阅读全文」（document 视图）排版：引用片段视图按**字符偏移**做精确
   * 高亮，排版化会让偏移失效——那是给引用定位用的视图，全文视图另有排版。
   */
  const MARKDOWN_EXTS = new Set(['.md', '.markdown']);

  /** 该路径是否是 markdown 文档（渲染型文本：需要排版）。 */
  function isMarkdownPath(relPath) {
    return MARKDOWN_EXTS.has(richExtOf(relPath));
  }

  /**
   * 当前正文是否"可排版"：md 文档 + 渲染管线在场 + 阅读全文 + 不是逐字稿。
   *
   * `renderText`（决定排版还是原文）与 `renderActions`（"查看源码"入口）共用
   * 这一条判据——两边各写一份必然漂移：一边给了按钮、另一边却不排版（或反之），
   * 用户点下去像没反应。
   *
   * `useBlocks` 由 renderText 传入（它已经算过一次对话块）；工具栏现算即可。
   */
  function canRenderMarkdown(result = activeResult, useBlocks = null) {
    if (activeView !== 'document') return false;
    if (typeof renderMarkdown !== 'function') return false;
    if (!String(result?.text || '')) return false;
    if (!isMarkdownPath(activeAnchor?.path || result?.displayPath)) return false;
    const blocks = useBlocks == null
      ? splitDialogueBlocks(String(result?.text || '')).length >= 2
      : useBlocks;
    return !blocks;
  }

  // ── 排版后正文里的引用定位 ─────────────────────────────────────────────
  /**
   * 原文偏移（charStart/charEnd）在 markdown 渲染后不再对应 DOM 字符位置，
   * 于是改用「摘录文本 → 文本节点搜索」：清洗 md 记号 + 归一化空白后匹配。
   * 单节点匹配不到（一条引用被标题/加粗/列表拆到多个节点）时退到「整块标记」
   * ——保证点开引用总能落到可见位置，而不是静默停在第 1 屏。
   */
  function mdNormSpace(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  /** 去掉行首 md 记号（标题/引用/列表序号/代码围栏）与行内强调符。 */
  function mdStripMarks(value) {
    return String(value || '').split('\n').map((line) => line
      .replace(/^\s*(?:#{1,6}[ \t]+|>[\t ]?|[-*+•][ \t]+|\d+[.、)][ \t]+|```+[^\n]*|~~~+)/, ''))
      .join(' ');
  }

  /** 高亮前清洗：行首记号 + 行内强调符 + 空白归一（与渲染后正文的形态一致）。 */
  function mdCleanQuote(value) {
    return mdNormSpace(mdStripMarks(value).replace(/\*\*|__|`|~~/g, ''));
  }

  /**
   * 归一化后的下标 → 原文下标（空白被折叠成一个空格，两边要各自换算）。
   * 找不到精确位置时给文档尾——只用于"近似窗口"，不追求逐字对齐。
   */
  function mdApproxRawStart(raw, normIndex) {
    let position = 0;
    let inWhitespace = false;
    for (let i = 0; i < raw.length; i++) {
      if (/\s/.test(raw[i])) {
        if (!inWhitespace) {
          if (position === normIndex) return i;
          position++;
          inWhitespace = true;
        }
      } else {
        inWhitespace = false;
        if (position === normIndex) return i;
        position++;
      }
    }
    return Math.max(0, raw.length - 1);
  }

  /** 正文里的可见文本节点（手写递归：不依赖 TreeWalker，测试沙箱也能跑）。 */
  function mdTextNodes(host) {
    const out = [];
    const walk = (node) => {
      const children = node && node.childNodes;
      if (!children) return;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.nodeType === 3) {
          if (String(child.nodeValue || '').trim()) out.push(child);
        } else if (child.nodeType === 1) {
          walk(child);
        }
      }
    };
    walk(host);
    return out;
  }

  /** 在单个文本节点里包一个 `<mark>`（Range 不可用时返回 null，交给块级兜底）。 */
  function mdMarkRange(node, start, length) {
    if (typeof document.createRange !== 'function') return null;
    const end = Math.min(String(node.nodeValue || '').length, start + Math.max(length, 1));
    if (start < 0 || start >= end) return null;
    const owner = node.ownerDocument || document;
    const range = owner.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const mark = document.createElement('mark');
    try {
      range.surroundContents(mark);
    } catch (_) {
      return null; // 跨节点/非法 Range：不阻断阅读
    }
    return mark;
  }

  /** 摘录里的显著词（长度 ≥3、去重）：块级兜底按重合词数挑最像的那一块。 */
  function mdTokens(value) {
    const seen = new Set();
    const out = [];
    String(value || '').split(/[^\p{L}\p{N}]+/u).forEach((token) => {
      const cleaned = token.replace(/[^\p{L}\p{N}_-]/gu, '');
      if (cleaned && cleaned.length >= 3 && !seen.has(cleaned)) {
        seen.add(cleaned);
        out.push(cleaned);
      }
    });
    return out;
  }

  /** 兜底：按重合词挑出最匹配的块级元素，整块标记 + 滚动到视野。 */
  function mdBlockFallback(host, cleaned) {
    const blocks = host && typeof host.querySelectorAll === 'function'
      ? Array.from(host.querySelectorAll('p,li,blockquote,h1,h2,h3,h4,h5,h6,pre,td,dd,dt,summary'))
      : [];
    const tokens = mdTokens(cleaned);
    if (!blocks.length || !tokens.length) return false;
    let best = null;
    let bestScore = 0;
    for (const block of blocks) {
      const text = mdNormSpace(block.textContent || '');
      if (!text) continue;
      let score = 0;
      for (const token of tokens) if (text.includes(token)) score++;
      if (score > bestScore) {
        bestScore = score;
        best = block;
      }
    }
    if (!best || bestScore < 1) return false;
    best.classList?.add?.('anchored-source-mark-block');
    try {
      best.scrollIntoView?.({ block: 'center' });
    } catch (_) {
      /* 滚动失败不影响阅读 */
    }
    return true;
  }

  /**
   * 在**已排版**的正文里定位并高亮一段摘录。返回 true = 已给出可见落点
   * （精确 `<mark>` 或块级标记）。
   */
  function mdHighlight(host, quote) {
    if (!host || !quote) return false;
    const cleaned = mdCleanQuote(quote);
    if (!cleaned) return false;
    const needles = [];
    const push = (candidate) => {
      const value = mdNormSpace(candidate);
      if (value.length >= 2 && !needles.includes(value)) needles.push(value);
    };
    push(cleaned.slice(0, 140));
    if (cleaned.length > 140) push(cleaned.slice(0, 80));
    push((cleaned.match(/^[^\n。！？!?；;，,]{0,60}/) || [''])[0]);
    const nodes = mdTextNodes(host);
    for (const needle of needles) {
      for (const node of nodes) {
        const raw = String(node.nodeValue || '');
        if (!raw.trim()) continue;
        let rawStart = -1;
        const index = mdNormSpace(raw).indexOf(needle);
        if (index >= 0) {
          rawStart = mdApproxRawStart(raw, index);
        } else {
          // 空白/标点归一化后仍匹配不上时，退到首个"实词"命中
          const word = (needle.match(/[\p{L}\p{N}][\p{L}\p{N}._-]{2,}/u) || [])[0];
          if (!word) continue;
          const at = raw.indexOf(word);
          if (at < 0) continue;
          rawStart = at;
        }
        if (rawStart < 0) continue;
        if (mdMarkRange(node, rawStart, needle.length * 2 + 8)) return true;
      }
    }
    return mdBlockFallback(host, cleaned);
  }

  // 纯函数出口：渲染层回归测试锁定清洗/归一化口径（与 kb-workbench 的
  // `__kbFvUtils` 同款做法，避免测试去复制一遍实现）。
  root.__kbMdUtils = {
    isMarkdownPath,
    normSpace: mdNormSpace,
    stripMarks: mdStripMarks,
    cleanQuote: mdCleanQuote,
    tokens: mdTokens,
    highlight: mdHighlight,
  };

  // ── 「文字转写」判定：纠错面板的准入条件 ────────────────────────────────
  /**
   * 纠错要解决的是**机器转写错词**（coxy → Cogseed / K 星 → K star），
   * 只有转写稿才有这个场景。方案、笔记、代码这类普通文本给入口只会误导
   * （真机反馈：纠错不该出现在所有文本上）。
   *
   * 判据 = 「名字像转写」或「正文像逐字稿」，任一成立即可；纯本地纯函数，
   * 不做模型判定（可测、可解释、不联网）：
   *   - 名字：转写 / 逐字稿 / 转录 / 实录 / 听写 / 字幕 / transcript / asr …
   *   - 正文：≥2 段「说话人 + 时间」块头（`splitDialogueBlocks` 的识别规则），
   *     或开头带一句转写声明（腾讯会议/飞书那类"机器识别结果仅供参考"）。
   */
  const TRANSCRIPT_NAME_RE = /(转写|逐字稿|转录|实录|听写|字幕|transcript|transcription|subtitle|asr)/i;
  const TRANSCRIPT_NOTICE_RE = /(机器识别结果仅供参考|实时转写|语音转写|自动转写|识别结果仅供参考)/;
  const TRANSCRIPT_MIN_BLOCKS = 2;

  function isTranscriptDocument(relPath, text) {
    const raw = String(text || '');
    if (TRANSCRIPT_NOTICE_RE.test(raw.slice(0, 4000))) return true;
    if (splitDialogueBlocks(raw).length >= TRANSCRIPT_MIN_BLOCKS) return true;
    const name = String(relPath || '').split(/[\\/]/).pop() || '';
    return TRANSCRIPT_NAME_RE.test(name);
  }

  /**
   * 只有"文字转写 + 阅读全文 + 已解析出文本 + 面板模块已加载"时才提供纠错入口。
   * 非转写文档（方案/笔记/代码）不出现这个按钮——它不是给普通文本用的能力。
   *
   * 判定包了 try：它跑在工具栏渲染里，判定本身出问题也不该让整条工具栏挂掉
   * （宁可少给一个入口）。
   */
  function canCorrect() {
    if (activeView !== 'document') return false;
    if (!activeResult?.resolved) return false;
    if (!String(activeResult?.text || '').length) return false;
    if (typeof root.KbTranscriptCorrect?.mount !== 'function') return false;
    try {
      return isTranscriptDocument(activeAnchor?.path || activeResult?.displayPath, activeResult?.text);
    } catch (error) {
      log?.warn('transcript detection failed', { error: error?.message || String(error) });
      return false;
    }
  }

  function destroyCorrection() {
    try { activeCorrection?.destroy?.(); } catch (_) { /* 关闭失败不阻塞 */ }
    activeCorrection = null;
    correctionOpen = false;
    const panel = element('[data-anchor-view-correct]');
    if (panel) {
      panel.hidden = true;
      panel.textContent = '';
    }
    element('.anchored-source-viewer')?.classList.remove('is-correct-open');
    const splitter = element('[data-anchor-view-split]');
    if (splitter) splitter.hidden = true;
  }

  /**
   * 打开纠错面板。文档被截断时（viewer 为省内存只给引用附近片段）先取全文：
   * 个人库走 contexts.read；空间库文件暂不支持（给出明确提示，不静默失败）。
   */
  async function resolveCorrectionText() {
    const inline = String(activeResult?.text || '');
    if (!activeResult?.truncated) return inline;
    const path = String(activeAnchor?.path || '').trim();
    const spaceId = activeAnchor?.spaceId;
    if (path && !spaceId) {
      try {
        const res = await root.cogseed.invoke('contexts.read', { path });
        const content = String(res?.content || res?.text || '');
        if (content) return content;
      } catch (error) {
        log?.warn('correction full-text read failed', { error: error?.message || String(error) });
      }
    }
    return inline;
  }

  async function toggleCorrection() {
    if (correctionOpen) {
      destroyCorrection();
      renderActions();
      return;
    }
    const panel = element('[data-anchor-view-correct]');
    if (!panel || !canCorrect()) return;
    panel.hidden = false;
    panel.textContent = '';
    setStatus(t('kb.viewer.loading_document', '正在读取原文…'), 'loading');
    let text = '';
    try {
      text = await resolveCorrectionText();
    } catch (_) {
      text = String(activeResult?.text || '');
    }
    if (!modalIsOpen()) return;
    setStatus('', '');
    try {
      activeCorrection = root.KbTranscriptCorrect.mount(panel, {
        text,
        docId: String(activeAnchor?.path || activeResult?.displayPath || 'transcript'),
        displayPath: String(activeResult?.displayPath || activeAnchor?.path || ''),
      });
      correctionOpen = true;
      element('.anchored-source-viewer')?.classList.add('is-correct-open');
    const splitter = element('[data-anchor-view-split]');
    if (splitter) splitter.hidden = false;
    bindSplitter();
    const saved = readSplitWidth();
    if (saved > 0) applySplitWidth(saved, { persist: false });
    } catch (error) {
      log?.warn('correction panel mount failed', { error: error?.message || String(error) });
      correctionOpen = false;
      panel.hidden = true;
      if (typeof root.uiToast === 'function') {
        root.uiToast(t('kb.transcriptCorrect.unavailable', '转写纠错面板暂时不可用'), { variant: 'warning' });
      }
    }
    renderActions();
  }

  function reasonText(reason) {
    if (reason === 'no_cache') return t('kb.viewer.no_cache', '该文件仍在索引中，暂时无法读取原文。');
    if (reason === 'out_of_scope') return t('kb.viewer.out_of_scope', '该文件不在当前资料边界内，无法打开。');
    if (reason === 'not_found') return t('kb.viewer.not_found', '已打开文件，但未找到对应的引用片段。');
    return t('kb.viewer.unavailable', '暂时无法读取该文件的原文。');
  }

  /**
   * 把逐字稿切成"发言人块"（纯函数，视觉规范 §四-2：多人对话用极淡底色区分说话人）。
   * 与主进程 `transcript_speaker_merge.parseTranscriptBlocks` 同一套识别规则
   * （名字 + 日期时间 / 名字｜时间 / 名字 时间），但这里只用于**阅读着色**，
   * 不改任何文本、不做任何替换。
   *
   * 时间**必须允许 1~3 段**（`02:45` / `1:00:35` / `01:00:35`）：腾讯会议同一份
   * 导出里，整点前给的是相对时钟 `王伟 02:45`，整点后才变成 `李强 01:00:35`。
   * 只认三段会把整点前的块头全部漏掉（真机事故 2026-09-18：一份 77 分钟的稿子，
   * 首个被识别的块头落在 `01:00:35`，前面 77% 的内容从不进 DOM，看着像被删了）。
   */
  function splitDialogueBlocks(text) {
    const raw = String(text || '');
    const lines = raw.split('\n');
    const headerRe = /^(?<speaker>.{1,24}?)\s+(?<date>\d{4}-\d{2}-\d{2})[ T](?<clock>\d{1,2}(?::\d{2}){1,2})\s*$/;
    const pipeRe = /^(?<speaker>.{1,24}?)\s*[｜|]\s*(?<clock>\d{1,2}(?::\d{2}){1,2})\s*$/;
    const plainRe = /^(?<speaker>.{1,24}?)\s+(?<clock>\d{1,2}(?::\d{2}){1,2})\s*$/;
    const blocks = [];
    let cursor = 0;
    let current = null;
    for (const line of lines) {
      const lineStart = cursor;
      cursor = lineStart + line.length + 1;
      const matched = line.match(headerRe) || line.match(pipeRe) || line.match(plainRe);
      if (!matched) continue;
      if (current) {
        current.end = lineStart;
        blocks.push(current);
      }
      current = {
        speaker: (matched.groups?.speaker || '').trim(),
        clock: matched.groups?.clock || '',
        /** 块头所在行（仅用于定位，渲染时被换成 meta 行）。 */
        start: lineStart,
        /** 正文起点：块头行的下一行——正文里**不含**块头原文。 */
        bodyStart: cursor,
        end: cursor,
      };
    }
    if (current) {
      current.end = raw.length;
      blocks.push(current);
    }
    return blocks.map((block, index) => ({ ...block, index }));
  }

  /**
   * 阅读字号三档（规范 §五-3：长时间校对要能快速调字号）。
   * 存在本机 localStorage（纯前端偏好，不进后端、不影响别人）。
   */
  const READER_SCALES = ['s', 'm', 'l'];
  const READER_SCALE_KEY = 'cogseed.readerScale';

  function readReaderScale() {
    try {
      const saved = root.localStorage?.getItem?.(READER_SCALE_KEY);
      return READER_SCALES.includes(saved) ? saved : 'm';
    } catch (_) {
      return 'm';
    }
  }

  function applyReaderScale(scale) {
    const value = READER_SCALES.includes(scale) ? scale : 'm';
    try {
      root.localStorage?.setItem?.(READER_SCALE_KEY, value);
    } catch (_) {
      /* 偏好写不进去也不该影响阅读 */
    }
    const dialog = activeModal?.dialog;
    if (dialog?.dataset) dialog.dataset.readerScale = value;
    return value;
  }

  function renderText(result) {
    const pre = element('[data-anchor-view-text]');
    const note = element('[data-anchor-view-note]');
    if (!pre || !note) return;
    pre.textContent = '';
    // 上一次渲染的形态标记要清掉（md 排版 / 对话块），否则切文档时样式会串
    if (pre.dataset) {
      delete pre.dataset.md;
      delete pre.dataset.blocks;
    }
    pre.classList?.remove?.('markdown-body');
    note.hidden = true;
    note.textContent = '';

    if (!result?.resolved) {
      setStatus(reasonText(result?.reason), 'warning');
      return;
    }

    setStatus('', '');
    const text = String(result.text || '');
    const textStart = Number.isFinite(Number(result.textStart)) ? Number(result.textStart) : 0;
    const absoluteStart = Number(result.charStart);
    const absoluteEnd = Number(result.charEnd);
    const markStart = Number.isFinite(absoluteStart) ? Math.max(0, Math.min(text.length, absoluteStart - textStart)) : 0;
    const markEnd = Number.isFinite(absoluteEnd) ? Math.max(markStart, Math.min(text.length, absoluteEnd - textStart)) : markStart;

    // 视觉规范 §一/§四-2：识别出多个发言人时，改成"对话块"渲染——每块之间有
    // 垂直间距、说话人+时间单独一行（小字号、浅灰）、不同说话人极淡底色区分；
    // 认不出块头（普通文档）时退回原来的整段渲染，不动任何既有行为。
    const blocks = splitDialogueBlocks(text);
    const useBlocks = blocks.length >= 2;

    // 阅读全文 + markdown 文档 + 未切到"源码"→ 排版渲染（`.markdown-body`
    // 那套排版规则）。逐字稿除外：它有专门的"对话块"渲染（说话人/时间/分段
    // 底色），排版成 HTML 会把块头结构冲成普通段落（转写稿的 .md 也走对话块）。
    // 渲染管线缺席（utils.js 未加载的异常加载序）时静默回落原文，读者至少
    // 有字可看，不会因为排版件缺失就打不开文件。
    const markdownDoc = canRenderMarkdown(result, useBlocks);
    if (!mdSourceMode && markdownDoc) {
      const html = String(renderMarkdown(text) || '');
      if (html.trim()) {
        pre.classList?.add?.('markdown-body');
        pre.dataset.md = 'rendered';
        pre.innerHTML = html;
        // 引用高亮：原文偏移在排版后失效，改按摘录文本在渲染结果里找落点
        const quote = markEnd > markStart ? text.slice(markStart, markEnd) : String(activeAnchor?.quote || '');
        if (quote && !mdHighlight(pre, quote)) {
          log?.warn('markdown highlight miss', { path: String(activeAnchor?.path || ''), quote: quote.slice(0, 40) });
        }
        if (result.truncated) {
          note.hidden = false;
          note.textContent = t('kb.viewer.truncated', '文档较长，当前显示包含引用位置的部分内容。');
        }
        // markdown 里的 $…$ 需要 MathJax 再排一次（管线只做保护，不负责排版）
        if (typeof typesetMath === 'function') {
          try {
            typesetMath(pre);
          } catch (_) {
            /* 数学排版失败不影响正文阅读 */
          }
        }
        requestAnimationFrame(() => pre.querySelector('mark')?.scrollIntoView({ block: 'center' }));
        return;
      }
    }

    // 走到这里还是 md 文档 + 用户手选了"源码" ⇒ 按原文渲染（等宽、保留空白的
    // `[data-md="source"]`），字符偏移精确高亮在这一形态下也重新成立。
    if (markdownDoc && mdSourceMode) pre.dataset.md = 'source';

    // 逐字稿（useBlocks）走对话块；普通文档继续走下面的整段/原文渲染
    if (useBlocks) {
      const speakers = [];
      for (const block of blocks) {
        if (!speakers.includes(block.speaker)) speakers.push(block.speaker);
      }
      pre.dataset.blocks = '1';
      /** 渲染一个字符区间；speaker 为空 = 块外文本（首块之前 / 末块之后）。 */
      const renderRange = (from, to, speaker, clock) => {
        const node = document.createElement('div');
        node.className = 'anchored-source-block';
        // 只用 3 档极淡底色循环（多人时不会变成调色盘）
        node.dataset.speakerIndex = String(Math.max(0, speakers.indexOf(speaker)) % 3);
        const head = document.createElement('div');
        head.className = 'anchored-source-block-meta';
        head.textContent = [speaker, clock].filter(Boolean).join(' · ');
        const body = document.createElement('div');
        body.className = 'anchored-source-block-body';
        const localStart = Math.max(0, markStart - from);
        const localEnd = Math.max(0, markEnd - from);
        const slice = text.slice(from, to);
        if (markEnd > markStart && localEnd > 0 && localStart < slice.length) {
          body.appendChild(document.createTextNode(slice.slice(0, localStart)));
          const mark = document.createElement('mark');
          mark.textContent = slice.slice(localStart, Math.min(localEnd, slice.length));
          body.appendChild(mark);
          body.appendChild(document.createTextNode(slice.slice(Math.min(localEnd, slice.length))));
        } else {
          body.appendChild(document.createTextNode(slice));
        }
        // 块外文本（首块之前 / 末块之后）没有说话人，不挂空 meta 行
        if (speaker || clock) node.appendChild(head);
        node.appendChild(body);
        pre.appendChild(node);
      };
      // 不变量：块头认不出只该影响**排版**，绝不能让内容静默消失。首块之前与
      // 末块之后的文本同样渲染出来——否则一次正则漏配就是整段原文"被删除"。
      const headEnd = Math.max(0, Math.min(text.length, blocks[0].start));
      if (text.slice(0, headEnd).trim()) renderRange(0, headEnd, '', '');
      for (const block of blocks) {
        renderRange(
          Math.max(block.bodyStart ?? block.start, 0),
          Math.min(block.end, text.length),
          block.speaker,
          block.clock,
        );
      }
      const tailStart = Math.max(0, Math.min(text.length, blocks[blocks.length - 1].end));
      if (text.slice(tailStart).trim()) renderRange(tailStart, text.length, '', '');
    } else {
      pre.appendChild(document.createTextNode(text.slice(0, markStart)));
      if (markEnd > markStart) {
        const mark = document.createElement('mark');
        mark.textContent = text.slice(markStart, markEnd);
        pre.appendChild(mark);
      }
      pre.appendChild(document.createTextNode(text.slice(markEnd)));
    }

    if (result.truncated) {
      note.hidden = false;
      note.textContent = t('kb.viewer.truncated', '文档较长，当前显示包含引用位置的部分内容。');
    }
    requestAnimationFrame(() => pre.querySelector('mark')?.scrollIntoView({ block: 'center' }));
  }

  function renderMeta(result) {
    const fullPath = String(result?.displayPath || activeAnchor?.path || '');
    // 只显示尾段（路口窄，长路径会被省略号吃掉）；完整路径放 title，hover 可见
    const tail = fullPath.split(/[\\/]/).filter(Boolean).pop() || fullPath;
    const bits = [tail].filter(Boolean);
    if (result?.page) bits.push(t('kb.viewer.page', '第 {page} 页', { page: result.page }));
    if (Number.isFinite(Number(result?.charStart)) && Number.isFinite(Number(result?.charEnd))) {
      bits.push(t('kb.viewer.characters', '字符 {start}–{end}', { start: result.charStart, end: result.charEnd }));
    }
    if (Number.isFinite(Number(result?.totalChars))) {
      bits.push(t('kb.viewer.total_chars', '共 {count} 字符', { count: result.totalChars }));
    }
    const metaHost = element('[data-anchor-view-meta]');
    if (metaHost && typeof metaHost.setAttribute === 'function') {
      // 窄窗口下这行一定会用省略号收尾——hover 要能看全（完整路径 + 全部信息）
      metaHost.setAttribute('title', `${fullPath}\n${bits.join(' · ')}`);
    }
    setMeta(bits.join(' · '));
  }

  function renderResult(result) {
    activeResult = result;
    activeModal?.dialog?.classList.toggle('anchored-source-modal--reader', activeView === 'document');
    renderMeta(result);
    renderText(result);
    renderActions();
  }

  function renderLoading() {
    activeResult = null;
    activeModal?.dialog?.classList.toggle('anchored-source-modal--reader', activeView === 'document');
    setMeta(String(activeAnchor?.path || ''));
    setStatus(activeView === 'document'
      ? t('kb.viewer.loading_document', '正在读取原文…')
      : t('kb.viewer.locating', '正在定位引用…'), 'loading');
    const pre = element('[data-anchor-view-text]');
    if (pre) pre.textContent = '';
    renderActions();
  }

  async function loadView(view) {
    if (!activeAnchor || !ensureModal()) return;
    activeView = view === 'document' ? 'document' : 'anchor';
    // 视图切换会换掉正文，纠错面板随之关闭，避免对旧文本做替换。
    destroyCorrection();
    const sequence = ++requestSequence;
    renderLoading();
    try {
      const result = await root.cogseed.invoke('cogseed.anchor.resolve', { ...activeAnchor, view: activeView });
      if (sequence !== requestSequence || !modalIsOpen()) return;
      if (result?.ok === false) throw new Error(result.error || 'anchor resolve failed');
      renderResult(result || { resolved: false, reason: 'no_text' });
    } catch (error) {
      if (sequence !== requestSequence || !modalIsOpen()) return;
      log?.warn('source viewer load failed', { error: error?.message || String(error) });
      renderResult({ resolved: false, reason: 'no_text' });
    }
  }

  /**
   * 排版类文件 → 富查看器。富查看器住在懒加载的 kb-workbench 里，桥不在时
   * **按需加载 KB 功能**（`loadRendererFeature('kb')` 只注入脚本，不切视图），
   * 而不是把 PDF/Word 退化成纯文本。返回 true = 已按排版打开。
   *
   * 这是真机反馈「word、pdf 等无法正常查看」的根因所在：引用 chip / 发现页
   * 桥缺席时会把 pdf 直接丢给纯文本阅读器（无排版 + 多出一个转写纠错按钮）。
   */
  function openViaRichViewer(anchor) {
    const bridge = () => (typeof root.__openKbRichFile === 'function' ? root.__openKbRichFile : null);
    const delegate = (fn) => Promise.resolve(fn(anchor)).then((opened) => opened !== false, () => false);
    const now = bridge();
    if (now) return delegate(now);
    const loader = typeof root.loadRendererFeature === 'function' ? root.loadRendererFeature : null;
    if (!loader) return Promise.resolve(false);
    return Promise.resolve(loader('kb'))
      .then(() => {
        const loaded = bridge();
        return loaded ? delegate(loaded) : false;
      })
      .catch(() => false);
  }

  function openAnchorViewer(anchor) {
    const path = String(anchor?.path || '').trim();
    if (!path) return Promise.resolve();
    if (isRichPreviewPath(path)) {
      return openViaRichViewer({ ...anchor, path }).then((handled) => (
        handled ? undefined : openTextViewer({ ...anchor, path })
      ));
    }
    return openTextViewer({ ...anchor, path });
  }

  function openTextViewer(anchor) {
    if (!ensureModal()) {
      if (typeof root.uiToast === 'function') {
        root.uiToast(t('kb.viewer.ui_unavailable', '原文查看器暂时不可用'), { variant: 'warning' });
      }
      return Promise.resolve();
    }
    activeAnchor = { ...anchor, path: String(anchor?.path || '').trim() };
    // 新文档 ⇒ 回到"排版阅读"默认（源码模式是这一份文档的临时选择，不粘到下一份）
    mdSourceMode = false;
    return loadView(anchor?.view === 'document' ? 'document' : 'anchor');
  }

  root.addEventListener?.('i18n-change', () => {
    if (!modalIsOpen()) return;
    const title = activeModal.dialog.querySelector('.ui-modal__title');
    const description = activeModal.dialog.querySelector('.ui-modal__description');
    if (title) title.textContent = t('kb.viewer.title', '原文查看器');
    if (description) description.textContent = t('kb.viewer.description', '查看知识库原文，并定位到引用片段。');
    if (activeResult) renderResult(activeResult);
    else renderLoading();
  });

  root.__openAnchorViewer = openAnchorViewer;

  if (typeof module !== 'undefined' && module.exports) module.exports = { formatFallback };
})(typeof window !== 'undefined' ? window : globalThis);
