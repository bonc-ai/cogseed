// ─── 安全与信任设置页（v3：评分环 + 能力覆盖 + 发现项抽屉 + 风险接受）───────
//
// 设计原则（按优先级）
//   1. 健康态一眼可读：一个评分环 + 一句话，不需要展开任何东西就知道"现在安全"。
//   2. 异常态可行动：每个异常都带一条"怎么办"，并且能直接执行（重新检查 / 接受风险）。
//   3. 分数可追问：点开任一技能都能看到分数怎么来的（逐类别扣分）、
//      到底扫了什么（覆盖信息）、命中了什么（发现项 + CWE/OWASP + 修复建议）。
//   4. 只读优先：检查与导出是后台动作，结果就地刷新，不新增阻塞弹窗。
//      唯一会写盘的动作是"接受风险"，且必须填理由与到期日。
//
// 与 v2 的差别（以及为什么）
//   v2 只能显示回执里的结论、评分与时间。用户看到"78/100"却无法知道扣分点，
//   看到"规则包 v1.0.0"却无法知道实际加载了多少条规则、gitleaks 是否可用。
//   v3 把"证据"这一层补上：详情抽屉按需触发一次带 --detail 的扫描，
//   主进程侧有字段白名单保证匹配原文不会到达渲染进程。

(() => {
  const $ = (sel) => document.querySelector(sel);

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // 共享组件的状态词汇表 —— 用错值**不会抛错**，只会静默降级成中性色。
  // 踩过一次：整页的 `tone: 'warning'` / `'danger'` 全部渲染成 neutral，
  // 于是「异常」和「正常」看起来一模一样。取值以 ui-status.js 为准：
  //   uiStatusPill / uiStatusDot / uiBadge → success | attention | critical | neutral | idle
  //   uiTag                              → variant: solid | outline | accent | mono | version | success
  const TONE_ATTENTION = 'attention';
  const TONE_CRITICAL = 'critical';
  const TONE_SUCCESS = 'success';
  const TONE_NEUTRAL = 'neutral';

  function ui(name, ...args) {
    const fn = window[name];
    if (typeof fn !== 'function') return '';
    try {
      return fn(...args);
    } catch (_) {
      // A shared factory rejecting its arguments must not blank the whole page.
      return '';
    }
  }

  function icon(name, cls) {
    return typeof window.uiIconHtml === 'function' ? window.uiIconHtml(name, cls || '') : '';
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function relTime(iso) {
    if (!iso) return t('settings.security.just_now_none');
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return t('settings.security.just_now_none');
    const mins = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
    if (mins < 1) return t('settings.security.just_now');
    if (mins < 60) return t('settings.security.mins_ago', { n: mins });
    const hours = Math.floor(mins / 60);
    if (hours < 24) return t('settings.security.hours_ago', { n: hours });
    return t('settings.security.days_ago', { n: Math.floor(hours / 24) });
  }

  function fmtBytes(n) {
    const value = Number(n) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
  const SEV_ORDER = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

  function sevTone(sev) {
    if (sev === 'critical' || sev === 'high') return TONE_CRITICAL;
    if (sev === 'medium') return TONE_ATTENTION;
    if (sev === 'low') return TONE_NEUTRAL;
    return TONE_NEUTRAL;
  }

  function sevLabel(sev) {
    return t(`settings.security.sev_${sev}`);
  }

  // ── 状态模型 ────────────────────────────────────────────────────────────
  const state = {
    status: null,          // skills.security.status 结果
    receipts: [],          // skills.trust.list
    skills: [],            // skills.list（选择器与总数）
    loading: true,
    filter: 'all',         // all | pass | risk | blocked | unchecked
    expanded: false,
    pickerOpen: false,
    pickerQuery: '',
    pickerDrawer: null,        // 选择器抽屉的控制器（在 document.body 上，不在页面里）
    checking: new Set(),   // 正在重新检查的 skillId
    drawer: null,          // { skillId, controller, evidence, loading, error, filter, accepting }
    liveMessage: '',
    composition: null,     // skills.security.composition 结果
    compositionOpen: false,
    compositionLoading: false,
    compositionError: null,
    coverageExpanded: false,   // 能力行：默认只列需要注意的项
    openRow: null,             // 展开的防护项：skills | coverage | composition
  };

  /**
   * Whether the alert-level state is the scanner's fault.
   *
   * `absent_by_build` is NOT: it is a supported build shape with reduced
   * coverage. Only a scanner that should be here and is not, or one whose bytes
   * do not match the release pin, counts as a fault.
   */
  function scannerIsFaulty() {
    const st = state.status || {};
    if (st.scanner !== 'present' && st.scanner !== 'absent_by_build') return true;
    return st.scannerIntegrity === 'tampered' || st.declarationIntegrity === 'tampered';
  }

  function heroKind() {
    const st = state.status;
    if (!st) return 'bad';
    // Receipts first. The hero is the one line a user reads before scrolling, so
    // it cannot say "有项目需要留意" while a skill has been *blocked* — that is a
    // different decision with a different action (inspect or delete, and do not
    // expect it in any conversation). The scanner block below then only has to
    // distinguish "component problem" from "everything fine".
    const counts = receiptCounts();
    if (counts.blocked > 0) return 'bad';
    // `absent_by_build` is a supported product shape: an open-source build that
    // intentionally ships without the bundled deep scanner. It is reduced
    // coverage (a warning), not a malfunction — only `broken`, an unrecognized
    // scanner state, or tamper evidence is alert-level.
    if (st.scanner !== 'present' && st.scanner !== 'absent_by_build') return 'bad';
    if (st.scannerIntegrity === 'tampered' || st.declarationIntegrity === 'tampered') return 'bad';
    if (st.scanner !== 'present' || st.scannerIntegrity !== 'verified' || st.declarationIntegrity !== 'verified') return 'warn';
    if ((st.capabilities || []).some((c) => c.status === 'degraded')) return 'warn';
    if (counts.risk > 0) return 'warn';
    return 'ok';
  }

  function decisionTone(decision) {
    if (decision === 'pass') return TONE_SUCCESS;
    if (decision === 'risk') return TONE_ATTENTION;
    if (decision === 'blocked') return TONE_CRITICAL;
    return TONE_NEUTRAL;
  }

  function decisionText(decision) {
    if (decision === 'pass') return t('settings.security.decision_pass');
    if (decision === 'risk') return t('settings.security.decision_risk');
    if (decision === 'blocked') return t('settings.security.decision_blocked');
    return t('settings.security.decision_unknown');
  }

  function integrityText(v) {
    return {
      verified: t('settings.security.integrity_verified'),
      tampered: t('settings.security.integrity_tampered'),
      unpinned: t('settings.security.integrity_unpinned'),
      unreadable: t('settings.security.integrity_unreadable'),
    }[v] || String(v || '—');
  }

  /**
   * 库级评分：已检查技能里最低的那个分数。
   *
   * 用最低分而不是平均分——「一个技能有问题」不能被九个干净技能稀释掉。
   * 没有任何评分时返回 null，让 UI 显示「—」而不是假装 100。
   */
  function libraryScore() {
    const scores = state.receipts
      .map((r) => (typeof r.securityScore === 'number' ? r.securityScore : null))
      .filter((n) => n !== null);
    return scores.length ? Math.min(...scores) : null;
  }

  /**
   * 一条回执该怎么读。
   *
   * `decision: 'risk'` 的含义是「扫描记录了至少一条任何级别的违规」——包括
   * `_meta.json` 缺 category 这类**声明规范**问题。真实画像上 60 条回执里 59 条是
   * risk，而深扫给同一批技能 100/100 分，且全部由规范族规则驱动
   * （`shape_staged_ceiling_missing` 57 条、`frontmatter_*` 2 条、1 条八项全是
   * frontmatter_/skill_meta_）。把这些算成「需要留意」会让整库都带警报，用户学会
   * 忽略之后，真正的安全问题也没人看。
   *
   * 判定由主进程给出（`skill_verdict.ts` 的 `securityNotableOf`，技能列表用的是
   * 同一个），页面**不重算**——两处各算一次正是这两块界面此前结论相反的原因。
   * 字段缺失时按「值得注意」处理：多显示一条记账问题，好过藏掉一条安全问题。
   */
  function receiptIsSecurityRisk(r) {
    return !!r && r.decision === 'risk' && r.securityNotable !== false;
  }

  function receiptIsDeclarationOnly(r) {
    return !!r && r.decision === 'risk' && r.securityNotable === false;
  }

  function receiptDecisionText(r) {
    return receiptIsDeclarationOnly(r)
      ? t('settings.security.decision_declaration') : decisionText(r.decision);
  }

  function receiptDecisionTone(r) {
    return receiptIsDeclarationOnly(r) ? TONE_NEUTRAL : decisionTone(r.decision);
  }

  function receiptCounts() {
    const counts = { pass: 0, risk: 0, blocked: 0, unchecked: 0, declaration: 0 };
    const seen = new Set();
    for (const r of state.receipts) {
      seen.add(r.skillId);
      // risk 只统计值得当作**安全问题**的那些；只有声明规范问题的单独计一档。
      // 两档都保留可见性：规范问题进「仅规范」筛选，不被隐藏。
      if (receiptIsSecurityRisk(r)) counts.risk += 1;
      else if (receiptIsDeclarationOnly(r)) counts.declaration += 1;
      else if (counts[r.decision] !== undefined) counts[r.decision] += 1;
    }
    counts.unchecked = Math.max(0, state.skills.length - seen.size);
    return counts;
  }

  /**
   * 结论是否基于另一个规则包。
   *
   * 这是**显示层**比较：回执记录的规则包 vs 当前引擎的规则包。主进程的
   * `isReceiptStale()` 还能发现「内容变了 / 校验器升级了」，但那要对每个技能目录
   * 做一次哈希，不适合每次打开页面跑 60 次；这里只回答用户最需要知道的那件事——
   * 「这些结论是旧规则包给的」，并且给出重新检查的入口。
   */
  function staleReceipts() {
    const current = (state.status || {}).sentryRulesetVersion;
    if (!current) return [];
    return state.receipts.filter((r) => r.rulesetVersion && r.rulesetVersion !== current);
  }

  // ── 组件 ────────────────────────────────────────────────────────────────

  /**
   * 评分环。用 SVG 而不是 CSS conic-gradient：环上的分数需要作为可访问文本
   * 存在，而 conic-gradient 只能画不能读。
   */
  /**
   * 分数的视觉分档。**唯一**的分档函数：评分环与表格里的分数条都用它。
   *
   * 两处各自写一套阈值是这类 UI 最容易出的问题——同一个 62 分，环是琥珀、
   * 条是红色，用户不知道信哪个。分档只写一次，颜色由 CSS 按 `data-band`
   * 决定，改阈值不会漏掉某一处。
   */
  function scoreBand(score) {
    if (typeof score !== 'number') return 'unknown';
    if (score >= 90) return 'ok';
    if (score >= 70) return 'warn';
    if (score >= 40) return 'mid';
    return 'bad';
  }

  function scoreRing(score, size) {
    const dim = size === 'sm' ? 64 : 92;
    const stroke = size === 'sm' ? 5 : 7;
    const radius = (dim - stroke) / 2;
    const circumference = 2 * Math.PI * radius;
    const value = typeof score === 'number' ? Math.max(0, Math.min(100, score)) : null;
    const ratio = value === null ? 0 : value / 100;
    const band = scoreBand(value);
    const label = value === null ? '—' : String(value);
    const caption = size === 'sm'
      ? ''
      : `<div class="sec-ring-caption">${esc(t('settings.security.ring_caption'))}</div>`;
    return `<div class="sec-ring sec-ring--${band}${size === 'sm' ? ' sec-ring--sm' : ''}">
      <svg viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" role="img"
           aria-label="${esc(t('settings.security.ring_aria', { score: label }))}">
        <circle class="sec-ring-track" cx="${dim / 2}" cy="${dim / 2}" r="${radius}"
                fill="none" stroke-width="${stroke}"></circle>
        <circle class="sec-ring-value" cx="${dim / 2}" cy="${dim / 2}" r="${radius}"
                fill="none" stroke-width="${stroke}" stroke-linecap="round"
                stroke-dasharray="${circumference.toFixed(2)}"
                stroke-dashoffset="${(circumference * (1 - ratio)).toFixed(2)}"
                transform="rotate(-90 ${dim / 2} ${dim / 2})"></circle>
      </svg>
      <div class="sec-ring-number">${esc(label)}</div>
      ${caption}
    </div>`;
  }

  function heroHtml(kind) {
    const st = state.status || {};
    const tagTone = kind === 'ok' ? TONE_SUCCESS
      : kind === 'warn' ? TONE_ATTENTION : TONE_CRITICAL;
    const tagText = kind === 'ok' ? t('settings.security.tag_ok')
      : kind === 'warn' ? t('settings.security.tag_attention') : t('settings.security.tag_alert');
    // 'bad' has two distinct causes and they need different words: a tampered or
    // broken scanner is "reinstall the app", a blocked skill is "look at the list
    // below". Picking by kind alone sent the user to the wrong action — measured:
    // a scanner-free build with one blocked skill showed the tamper wording,
    // blaming the scanner for something a skill did.
    const level = kind === 'bad' ? (scannerIsFaulty() ? 'alert' : 'blocked') : kind;
    const title = level === 'ok' ? t('settings.security.hero_ok')
      : level === 'warn' ? t('settings.security.hero_attention')
        : level === 'blocked' ? t('settings.security.hero_blocked')
          : t('settings.security.hero_alert');
    const desc = level === 'ok' ? t('settings.security.hero_ok_desc')
      : level === 'warn' ? t('settings.security.hero_attention_desc')
        : level === 'blocked' ? t('settings.security.hero_blocked_desc')
          : t('settings.security.hero_alert_desc');
    const last = state.receipts[0];
    const lastAt = last && last.scannedAt
      ? t('settings.security.last_checked_at', { time: relTime(last.scannedAt) }) : '';
    const scannerText = st.scanner === 'present' ? t('settings.security.scanner_present')
      : st.scanner === 'absent_by_build' ? t('settings.security.scanner_absent_build')
        : st.scanner === 'broken' ? t('settings.security.scanner_broken')
          : t('settings.security.status_unknown');
    const metaRow = (label, value) => value
      ? `<span class="sec-meta-item"><span class="sec-meta-label">${esc(label)}</span><b>${esc(value)}</b></span>`
      : '';
    return `<section class="sec-hero" data-kind="${esc(kind)}">
      ${scoreRing(libraryScore(), 'lg')}
      <div class="sec-hero-main">
        <h2 class="sec-hero-title">
          <span>${esc(title)}</span>
          ${ui('uiStatusPill', { label: tagText, tone: tagTone })}
        </h2>
        <p class="sec-hero-desc">${esc(desc)}${lastAt ? ` ${esc(lastAt)}` : ''}</p>
        <div class="sec-hero-meta">
          ${metaRow(t('settings.security.scanner_label'), scannerText)}
          ${metaRow(t('settings.security.sentry_engine'),
            st.sentryEngineVersion ? `skill-sentry ${st.sentryEngineVersion}` : '')}
          ${metaRow(t('settings.security.ruleset'), st.sentryRulesetVersion || '')}
          ${metaRow(t('settings.security.rule_count'), st.rules && st.rules.total ? String(st.rules.total) : '')}
          ${metaRow(t('settings.security.integrity_label'), integrityText(st.scannerIntegrity))}
        </div>
      </div>
      <div class="sec-hero-actions">
        ${ui('uiButton', {
          label: t('settings.security.refresh'), role: 'primary', size: 'sm', icon: 'refresh',
          attrs: { 'data-action': 'refresh' },
        })}
        ${ui('uiButton', {
          label: t('settings.security.check_one'), size: 'sm', icon: 'search',
          attrs: { 'data-action': 'toggle-picker', 'aria-expanded': state.pickerOpen ? 'true' : 'false' },
        })}
        ${ui('uiButton', {
          label: t('settings.security.export'), size: 'sm', icon: 'download',
          attrs: { 'data-action': 'export' },
        })}
      </div>
    </section>`;
  }

  /**
   * 异常态的可行动提示。健康态什么都不渲染——一条永远存在的提示等于噪音。
   */
  function issuesHtml(kind) {
    if (kind === 'ok') return '';
    const st = state.status || {};
    const items = [];
    if (st.scanner === 'broken') {
      items.push({ icon: 'warning', tone: 'attention', text: t('settings.security.issue_scanner_broken') });
    } else if (st.scanner === 'absent_by_build') {
      items.push({ icon: 'info', tone: 'attention', text: t('settings.security.scanner_not_present_sub') });
    }
    if (st.scannerIntegrity === 'tampered' || st.declarationIntegrity === 'tampered') {
      items.push({ icon: 'warning', tone: 'attention', text: t('settings.security.hero_alert_desc') });
    } else if (st.scannerIntegrity !== 'verified' || st.declarationIntegrity !== 'verified') {
      items.push({ icon: 'info', tone: 'attention', text: t('settings.security.integrity_not_verified_sub') });
    }
    const degraded = (st.capabilities || []).filter((c) => c.status === 'degraded');
    if (degraded.length) {
      items.push({
        icon: 'info',
        tone: 'attention',
        text: t('settings.security.issue_degraded', {
          items: degraded.map((c) => t(`settings.security.cap_${c.id}`)).join('、'),
        }),
      });
    }
    // 与「降级」分开：这一类是整个能力未启用，装工具即可解锁，是可行动的。
    const needsTool = (st.capabilities || []).filter((c) => c.status === 'needs_tool');
    if (needsTool.length) {
      items.push({
        icon: 'info',
        // 中性色：这是「装个工具就能解锁」的可行动提示，不是「防护变差了」。
        // 用琥珀会让整条横幅读成告警，正是这次要修的那个观感。
        tone: 'info',
        text: t('settings.security.issue_needs_tool', {
          items: needsTool.map((c) => t(`settings.security.cap_${c.id}`)).join('、'),
        }),
      });
    }
    if (!items.length) return '';
    return `<div class="sec-issues" role="list">
      ${items.map((i) => `<div class="sec-issue" role="listitem" data-tone="${esc(i.tone || 'attention')}">
        <span class="sec-issue-icon" aria-hidden="true">${icon(i.icon)}</span>
        <span>${esc(i.text)}</span></div>`).join('')}
    </div>`;
  }

  function capabilityStatusTone(status) {
    if (status === 'implemented') return TONE_SUCCESS;
    if (status === 'partial' || status === 'degraded') return TONE_ATTENTION;
    // needs_tool 是「装个工具就能解锁」，不是「防护变差了」——用中性色，
    // 否则整列都是琥珀点，读起来还是「我这装坏了」。
    return TONE_NEUTRAL;
  }

  function capabilityStatusText(status) {
    if (status === 'implemented') return t('settings.security.cap_status_on');
    if (status === 'partial') return t('settings.security.cap_status_partial');
    if (status === 'needs_tool') return t('settings.security.cap_status_needs_tool');
    if (status === 'degraded') return t('settings.security.cap_status_degraded');
    return t('settings.security.cap_status_off');
  }

  /**
   * 能力覆盖。这一节回答的是「100 分意味着什么」——扫了什么、没扫什么。
   * 没有它，一个满分既可能是"全量规则扫过且干净"，也可能是"规则根本没加载"。
   */
  function coverageBodyHtml() {
    const st = state.status || {};
    const caps = st.capabilities || [];
    if (!caps.length) {
      return ui('uiEmptyState', {
        kind: 'quiet', title: t('settings.security.scanner_not_present_sub'),
      });
    }
    const tools = st.externalTools || [];
    const rules = st.rules || {};
    // 注意力倒置：默认只列「需要注意」的项。旧版把 16 格全摊开，13 格是「可用」，
    // 真正要处理的 3 项排在第 14–16 格。展开态也把需要注意的排在最前。
    const attention = caps.filter((c) => c.status !== 'implemented');
    const healthy = caps.filter((c) => c.status === 'implemented');
    const listed = state.coverageExpanded ? [...attention, ...healthy] : attention;
    const chips = listed.map((c) => {
      const reason = c.reason ? ` · ${t(`settings.security.cap_reason_${c.reason}`)}` : '';
      return `<li class="sec-cap" data-status="${esc(c.status)}">
        ${ui('uiStatusDot', { tone: capabilityStatusTone(c.status) })}
        <span class="sec-cap-name">${esc(t(`settings.security.cap_${c.id}`))}</span>
        <span class="sec-cap-state">${esc(capabilityStatusText(c.status))}${esc(reason)}</span>
      </li>`;
    }).join('');
    const toolChips = tools.map((tool) => ui('uiTag', {
      label: `${tool.id}${tool.available ? '' : ` · ${t('settings.security.tool_missing')}`}`,
      variant: tool.available ? 'success' : 'outline',
    })).join(' ');
    const toggle = caps.length > attention.length
      ? ui('uiButton', {
        label: state.coverageExpanded
          ? t('settings.security.coverage_show_attention', { n: attention.length })
          : t('settings.security.coverage_show_all', { n: caps.length }),
        role: 'ghost', size: 'sm',
        iconEnd: state.coverageExpanded ? 'chevron-up' : 'chevron-down',
        attrs: { 'data-action': 'toggle-coverage', 'aria-expanded': state.coverageExpanded ? 'true' : 'false' },
      })
      : '';

    return `<div class="sec-rowbody">
      ${rules.total ? `<div class="sec-rulebar">
        ${ui('uiTag', { label: t('settings.security.rule_count_value', { n: rules.total }) })}
        ${ui('uiTag', { label: t('settings.security.hard_block_value', { n: rules.hardBlock }) })}
        ${(rules.groups || []).length ? ui('uiTag', {
          label: t('settings.security.rule_groups_value', { n: rules.groups.length }),
        }) : ''}
        ${rules.versioned ? '' : ui('uiTag', {
          label: t('settings.security.rules_builtin_only'), variant: 'outline',
        })}
        ${st.interpreter ? ui('uiTag', { label: t('settings.security.interpreter_ok'), variant: 'success' }) : ''}
        ${tools.length ? `<span class="sec-aside-label">${esc(t('settings.security.external_tools'))}</span> ${toolChips}` : ''}
      </div>` : ''}
      <ul class="sec-caps">${chips}</ul>
      ${toggle ? `<div class="sec-rowfoot">${toggle}</div>` : ''}
    </div>`;
  }

  /**
   * 库级概览 + 筛选。
   *
   * 数字与筛选拆成两件事：数字是**信息**（一段文字，屏幕阅读器一次读完），
   * 筛选是**控件**（走共享的 uiSegmentedControl，键盘/焦点行为由共享层负责）。
   *
   * 早先的版本把两者合成一排大数字按钮，代价是页面自己手写 button 元素——
   * 那会绕开共享控件的无障碍与键盘契约，也被 renderer 闸门正确地拦下。
   */
  function filteredReceipts() {
    if (state.filter === 'all') return state.receipts;
    // risk / declaration 两档走的是「这条回执在安全上算不算问题」，与筛选器上
    // 显示的数字同源，否则点进去看到的条数和标签上的数字对不上。
    if (state.filter === 'risk') return state.receipts.filter(receiptIsSecurityRisk);
    if (state.filter === 'declaration') return state.receipts.filter(receiptIsDeclarationOnly);
    return state.receipts.filter((r) => r.decision === state.filter);
  }

  /**
   * 一行只留 4 列。6 列在窄栏会把右侧操作按钮挤出可视区（实测被裁）。
   * 副标题也只保留**本行特有**的信息：时间每行不同；规则库降级只在该技能上出现，
   * 能解释它为什么分低。扫描方式/隔离状态每行都一样，逐行重复是噪音，移入详情抽屉。
   */
  function receiptRow(r) {
    const findings = typeof r.violationCount === 'number' && r.violationCount > 0
      ? `${r.violationCount} ${t('settings.security.col_findings')}` : '';
    const sub = [
      relTime(r.scannedAt),
      r.rulesDegraded ? t('skills.security_rules_degraded') : '',
      findings,
    ].filter(Boolean).join(' · ');
    const busy = state.checking.has(r.skillId);
    return `<tr data-skill="${esc(r.skillId)}">
      <td>
        <div class="sec-id">
          <div class="sec-dot" aria-hidden="true">${esc(String(r.skillId).slice(0, 1).toUpperCase())}</div>
          <div class="sec-id-body">
            <div class="sec-id-name">${esc(r.skillId)}</div>
            <div class="sec-id-sub">${esc(sub || '—')}</div>
          </div>
        </div>
      </td>
      <td>${ui('uiStatusPill', { label: receiptDecisionText(r), tone: receiptDecisionTone(r) })}</td>
      <td>${scoreCell(r.securityScore)}</td>
      <td class="sec-row-actions">
        ${ui('uiButton', {
          label: t('settings.security.detail'), role: 'ghost', size: 'sm', className: 'sec-link',
          attrs: { 'data-action': 'detail', 'data-skill': r.skillId },
        })}
        ${ui('uiButton', {
          label: busy ? t('settings.security.checking') : t('settings.security.recheck'),
          role: 'ghost', size: 'sm', className: 'sec-link',
          loading: busy,
          attrs: { 'data-action': 'recheck', 'data-skill': r.skillId },
        })}
      </td>
    </tr>`;
  }

  function scoreCell(score) {
    if (typeof score !== 'number') return '<span class="sec-score-num">—</span>';
    const band = scoreBand(score);
    return `<div class="sec-score">
      <div class="sec-score-bar" role="img" aria-label="${esc(t('settings.security.score_aria', { score }))}">
        <i data-band="${esc(band)}" style="width:${Math.max(4, Math.min(100, score))}%"></i>
      </div>
      <span class="sec-score-num">${score}</span>
    </div>`;
  }

  function receiptsBodyHtml() {
    const counts = receiptCounts();
    const filterItems = [
      { key: 'all', label: t('settings.security.stat_all'), count: state.skills.length },
      { key: 'pass', label: t('settings.security.stat_pass'), count: counts.pass },
      { key: 'risk', label: t('settings.security.stat_risk'), count: counts.risk },
      { key: 'declaration', label: t('settings.security.stat_declaration'), count: counts.declaration },
      { key: 'blocked', label: t('settings.security.stat_blocked'), count: counts.blocked },
      { key: 'unchecked', label: t('settings.security.stat_unchecked'), count: counts.unchecked },
    ];
    // 同一组数字曾渲染两遍：可见的文字摘要一行，紧接着一个内容相同的分段控件。
    // 分段控件本身就是数字的载体，所以只保留它；为屏幕阅读器保留同一句话，视觉隐藏。
    const srSummary = filterItems.map((item) => `${item.label} ${item.count}`).join(' · ');
    const rows = filteredReceipts();
    const visible = state.expanded ? rows : rows.slice(0, 10);
    const stale = staleReceipts();
    const notes = [];
    if (counts.declaration) {
      notes.push(t('settings.security.receipts_declaration_note', { n: counts.declaration }));
    }
    if (stale.length) {
      notes.push(t('settings.security.receipts_stale_note', {
        n: stale.length,
        receipt: stale[0].rulesetVersion || '',
        current: (state.status || {}).sentryRulesetVersion || '',
      }));
    }
    // 中性提示条，不是告警：这一条说的正是「不是安全问题」。用琥珀色会把
    // 「声明少个字段」读成和「扫描器被篡改」同一档严重——同一个教训，见
    // `.sec-issue[data-tone="info"]` 的注释。
    const notesHtml = notes.length
      ? `<div class="sec-issues" role="list">${notes.map((note) => `<div class="sec-issue" role="listitem" data-tone="info">
          <span class="sec-issue-icon" aria-hidden="true">${icon('info')}</span>
          <span>${esc(note)}</span>
        </div>`).join('')}</div>`
      : '';
    const empty = state.filter === 'all'
      ? ui('uiEmptyState', {
        kind: 'explained',
        title: t('settings.security.no_receipts'),
        hint: t('settings.security.no_receipts_hint'),
        icon: 'shield-check',
      })
      : ui('uiEmptyState', {
        kind: 'quiet',
        title: t('settings.security.no_receipts_filtered'),
      });
    return `<div class="sec-rowbody">
      <div class="sec-stats">
        <p class="sec-visually-hidden">${esc(srSummary)}</p>
        ${ui('uiSegmentedControl', {
          ariaLabel: t('settings.security.stats_aria'),
          value: state.filter,
          items: filterItems,
          attrs: { 'data-role': 'library-filter' },
        })}
      </div>
      ${notesHtml}
      <div class="sec-table-wrap">
        <table class="sec-table">
          <caption class="sec-visually-hidden">${esc(t('settings.security.recent_title'))}</caption>
          <thead><tr>
            <th scope="col">${esc(t('settings.security.col_skill'))}</th>
            <th scope="col">${esc(t('settings.security.col_decision'))}</th>
            <th scope="col" class="sec-num">${esc(t('settings.security.col_score'))}</th>
            <th scope="col"><span class="sec-visually-hidden">${esc(t('settings.security.col_actions'))}</span></th>
          </tr></thead>
          <tbody>${visible.length ? visible.map(receiptRow).join('')
            : `<tr><td colspan="4">${empty}</td></tr>`}</tbody>
        </table>
        <div class="sec-table-foot">
          <span class="sec-hint">${esc(t('settings.security.table_foot_hint'))}</span>
          ${rows.length > 10 ? ui('uiButton', {
            label: state.expanded ? t('settings.security.view_recent') : t('settings.security.view_all'),
            role: 'ghost', size: 'sm', className: 'sec-link',
            attrs: { 'data-action': 'toggle-all' },
          }) : ''}
        </div>
      </div>
    </div>`;
  }

  /**
   * 「检查指定技能…」的选择器。
   *
   * 从**右侧抽屉**打开，而不是页面流里的内联卡片。内联卡片有两个滚动问题：
   * 它在防护项行下面，所以要滚页面才够得到；列表自身又只有 280px 高，
   * 超过约 5 个技能就要滚列表。抽屉占满高度，一次能看到远多于 5 个技能，
   * 且复用共享 uiDrawer，不新增页面本地浮层。
   */
  function pickerListHtml() {
    const q = state.pickerQuery || '';
    const matches = state.skills
      .filter((sk) => !q || String(sk.id || '').toLowerCase().includes(q.toLowerCase())
        || String(sk.name || '').toLowerCase().includes(q.toLowerCase()))
      .slice(0, 200);
    const receiptById = new Map(state.receipts.map((r) => [r.skillId, r]));
    if (!matches.length) {
      return ui('uiEmptyState', { kind: 'quiet', title: t('settings.security.picker_empty') });
    }
    return matches.map((sk) => {
      const rc = receiptById.get(sk.id);
      const busy = state.checking.has(sk.id);
      // 抽屉只有 480px，单行放不下「ID + 名称 + 两个按钮」——实测名称会被省略号
      // 吃掉一大截。改成两行式：左列 ID/名称各占一行，右侧动作固定。
      return `<div class="sec-picker-item" role="listitem">
        <span class="sec-picker-text">
          <span class="sec-picker-name">${esc(sk.id)}</span>
          <span class="sec-picker-sub">${esc(sk.name || '')}${rc ? ` · ${esc(receiptDecisionText(rc))}` : ''}</span>
        </span>
        <span class="sec-picker-actions">
          ${ui('uiButton', {
            label: t('settings.security.detail'), role: 'ghost', size: 'sm', className: 'sec-link',
            attrs: { 'data-action': 'detail', 'data-skill': sk.id },
          })}
          ${ui('uiButton', {
            label: busy ? t('settings.security.checking') : t('settings.security.check_action'),
            role: 'ghost', size: 'sm', className: 'sec-link', loading: busy,
            attrs: { 'data-action': 'check', 'data-skill': sk.id },
          })}
        </span>
      </div>`;
    }).join('');
  }

  /** 抽屉内容：搜索框固定在顶部，列表占满剩余高度自己滚。 */
  function pickerBodyHtml() {
    return `${ui('uiInput', {
      id: 'settings-security-picker-input', type: 'search', className: 'sec-picker-input',
      placeholder: t('settings.security.search_placeholder'), value: state.pickerQuery || '',
      attrs: { 'data-role': 'picker-input', 'aria-label': t('settings.security.search_placeholder') },
    })}
    <div class="sec-picker-list" role="list" data-role="picker-list">${pickerListHtml()}</div>`;
  }

  function pickerPanelBody(controller) {
    return controller && controller.drawer
      ? controller.drawer.querySelector('.ui-drawer__body') : null;
  }

  function refreshPickerList() {
    const body = pickerPanelBody(state.pickerDrawer);
    if (!body) return;
    const list = body.querySelector('[data-role="picker-list"]');
    if (list) list.innerHTML = pickerListHtml();
  }

  /**
   * 抽屉在 document.body 上，不在 #settings-security-body 里，所以页面那套
   * 事件委托收不到它——输入与点击必须绑在抽屉自己的 body 上（详情抽屉同理）。
   */
  function wirePicker(controller) {
    const panelBody = pickerPanelBody(controller);
    if (!panelBody || panelBody.dataset.pickerWired === '1') return;
    panelBody.dataset.pickerWired = '1';

    panelBody.addEventListener('input', (ev) => {
      const el = ev.target.closest('[data-role="picker-input"]');
      if (!el) return;
      state.pickerQuery = String(el.value || '');
      // 只重画列表：整块重建会让输入框失焦、光标跳到末尾。
      refreshPickerList();
    });

    panelBody.addEventListener('click', (ev) => {
      const el = ev.target.closest('[data-action]');
      if (!el) return;
      const action = el.dataset.action;
      if (action === 'check') {
        if (el.dataset.skill) recheckSkill(el.dataset.skill).then(refreshPickerList);
      } else if (action === 'detail') {
        if (el.dataset.skill) openDrawer(el.dataset.skill);
      }
    });
  }

  function openPicker() {
    if (state.pickerDrawer) return;
    const controller = ui('uiDrawer', {
      title: t('settings.security.check_one'),
      bodyHtml: pickerBodyHtml(),
      closeLabel: t('common.close'),
      initialFocus: '[data-role="picker-input"]',
      onClose() {
        state.pickerDrawer = null;
        state.pickerOpen = false;
        const btn = document.querySelector('[data-action="toggle-picker"]');
        if (btn) btn.setAttribute('aria-expanded', 'false');
      },
    });
    if (!controller) {
      // 共享抽屉不可用时给出可见反馈，而不是静默什么都不发生。
      ui('uiToast', t('settings.security.drawer_unavailable'), { variant: 'warning' });
      return;
    }
    state.pickerDrawer = controller;
    state.pickerOpen = true;
    wirePicker(controller);
    const btn = document.querySelector('[data-action="toggle-picker"]');
    if (btn) btn.setAttribute('aria-expanded', 'true');
  }

  function closePicker() {
    const controller = state.pickerDrawer;
    if (controller) controller.close('toggle');
  }

  /**
   * 组合风险（path-level）。
   *
   * 这一节回答的是**单技能报告答不了的问题**：两个各自通过的技能，能力合起来
   * 能走通一条有害路径（这里读凭据、那里发出去）。学术侧把这类风险归为
   * 「路径性质而非节点性质」，并指出逐技能扫描器对此「拦截能力有限」。
   *
   * 呈现上刻意克制：严重级最高 medium、默认收起、明确写出「这是能力组合，
   * 不是已证实的漏洞」以及「分析覆盖了 N / M 个技能」。把一段推断说成事实
   * 会让这一节变成噪音，而噪音会让真正的组合被忽略。
   */
  /**
   * 一条组合路径画成一张有向图：**节点是技能，连线是能力交接**。
   *
   * 这样「谁能把什么交给谁」直接读得出来，不必再在一句话里用「→」把技能名
   * 串起来——那句话正是这次要替换掉的形态。
   *
   * 三处刻意的选择：
   *  1. **不手写 SVG。** 这里没有一处几何量来自数据（评分环不同：弧长就是分数），
   *     所以它不构成 "Known non-icon inline SVG" 例外：节点是共享 uiButton、
   *     能力是共享 uiTag、边是 icons.js 的箭头。手算坐标还会在 4 种语言下
   *     因文案长度而错位。
   *  2. **能力按位置归属。** `participants[i]` 提供 `capabilities[i]`——这是主进程
   *     给出的路径语义（"按路径经过的顺序"），所以节点上只放**这一步**的能力。
   *     一个技能往往还具备本路径用不到的其它能力（真实数据里
   *     `claude:systematic-debugging` 同时有改写记忆与引入不可信内容），把它们
   *     都摊到节点上会让同一枚标签在一条路径里出现两次，图就不再是「两步」。
   *     只有两者长度不等（将来出现三能力路径且技能被复用时位置对应才失效）
   *     才退回按证据归属，并把归不上节点的能力单列出来。
   *  3. **跨路径参与者带徽章。** 同一个技能出现在多条路径里，处置它的收益高于
   *     只出现一次的——这是清单形态给不出的信息，也是画成图之后才成立的一列。
   */
  function compositionGraphHtml(path, skillsById, sharedCounts) {
    const caps = path.capabilities || [];
    const parts = path.participants || [];
    const paired = caps.length > 0 && caps.length === parts.length;
    const nodes = parts.map((skillId, i) => {
      if (paired) return { skill: skillId, caps: [caps[i]] };
      const known = skillsById.get(skillId);
      return {
        skill: skillId,
        caps: known && Array.isArray(known.capabilities)
          ? caps.filter((c) => known.capabilities.includes(c)) : [],
      };
    });
    // 数据异常时宁可把无法归属的能力单列出来，也不静默丢掉一条能力。
    const orphans = caps.filter((c) => !nodes.some((n) => n.caps.includes(c)));
    const capabilityTag = (c) => ui('uiTag', { label: t(`settings.security.capability_${c}`) });
    const boxes = nodes.map((node) => `<div class="sec-graph-node">
      ${ui('uiButton', {
        label: node.skill, role: 'ghost', size: 'sm', className: 'sec-link',
        attrs: { 'data-action': 'detail', 'data-skill': node.skill },
      })}
      ${node.caps.map(capabilityTag).join('')}
      ${sharedCounts[node.skill] > 1
        ? `<span class="sec-graph-shared">${icon('git-branch', 'ui-icon sec-graph-shared-icon')}${ui('uiBadge', {
          label: t('settings.security.composition_shared_paths', { n: sharedCounts[node.skill] }),
        })}</span>`
        : ''}
    </div>`);
    const edge = `<div class="sec-graph-edge" aria-hidden="true">${icon('arrow-right', 'ui-icon sec-graph-arrow')}</div>`;
    return `<div class="sec-graph">${boxes.join(edge)}</div>
      ${orphans.length ? `<div class="sec-path-skills">${orphans.map(capabilityTag).join('')}</div>` : ''}`;
  }

  function compositionBodyHtml() {
    const comp = state.composition;
    const paths = (comp && comp.paths) || [];
    const coverage = (comp && comp.coverage) || {};
    // 空态原先是约 350px 的居中大图标 + 三行说明，把页面撑出一个洞。
    // 现在是一行文字，动作按钮固定在行尾。
    const runButton = `<div class="sec-rowfoot"><span></span>${ui('uiButton', {
      label: state.compositionLoading
        ? t('settings.security.composition_running')
        : t('settings.security.composition_run'),
      role: 'secondary', size: 'sm', loading: state.compositionLoading,
      attrs: { 'data-action': 'run-composition' },
    })}</div>`;

    if (!comp) {
      return `<div class="sec-rowbody">
        <p class="sec-row-note"><b>${esc(t('settings.security.composition_idle'))}</b> · ${esc(t('settings.security.composition_idle_hint'))}</p>
        ${runButton}
      </div>`;
    }
    if (state.compositionError) {
      return `<div class="sec-rowbody">
        <p class="sec-row-note"><b>${esc(t('settings.security.composition_failed'))}</b> · ${esc(t('settings.security.composition_failed_hint'))}</p>
        ${runButton}
      </div>`;
    }
    const coverageLine = t('settings.security.composition_coverage', {
      analyzed: coverage.analyzedSkills || 0,
      total: coverage.resolvableSkills || coverage.analyzedSkills || 0,
    });
    const notes = [];
    if (coverage.budgetLimited) notes.push(t('settings.security.composition_budget'));
    // 目录里有名字但没有文件的条目要报出来：不报的话「已分析 48 / 48」会
    // 让人以为库只有 48 个技能，而面板里能搜到更多。
    if (coverage.unresolvedSkills) {
      notes.push(t('settings.security.composition_unresolved', { n: coverage.unresolvedSkills }));
    }
    const budgetNote = notes.length
      ? `<p class="sec-drawer-note">${esc(notes.join(' '))}</p>` : '';
    if (!paths.length) {
      return `<div class="sec-rowbody">
        <p class="sec-row-note"><b>${esc(t('settings.security.composition_clean'))}</b> · ${esc(coverageLine)}</p>
        ${budgetNote}
        ${runButton}
      </div>`;
    }
    const skillsById = new Map(((comp && comp.skills) || []).map((s) => [s.skillId, s]));
    // 同一技能出现在几条路径里。清单形态看不出来，图上看得出。
    const sharedCounts = {};
    for (const p of paths) {
      for (const id of p.participants || []) sharedCounts[id] = (sharedCounts[id] || 0) + 1;
    }
    return `<div class="sec-rowbody">
      <div class="sec-composition-meta">${esc(coverageLine)}</div>
      <ul class="sec-paths">
        ${paths.map((p) => `<li class="sec-path" data-severity="${esc(p.severity)}">
          <div class="sec-path-head">
            ${ui('uiStatusPill', { label: sevLabel(p.severity === 'high' ? 'high' : 'medium'), tone: sevTone(p.severity) })}
            <span class="sec-path-name">${esc(t(`settings.security.path_${p.id}`))}</span>
          </div>
          <p class="sec-path-desc">${esc(t(`settings.security.path_${p.id}_desc`))}</p>
          ${compositionGraphHtml(p, skillsById, sharedCounts)}
        </li>`).join('')}
      </ul>
      <p class="sec-hint">${esc(t('settings.security.composition_caveat'))}</p>
      ${budgetNote}
      ${runButton}
    </div>`;
  }

  /**
   * 防护项：hero 以下的三行「图标 + 名称 + 一句状态」，点开才展开明细。
   *
   * 形态借自杀毒/安全类软件主界面（Windows 安全中心、火绒、Kaspersky 等）：
   *   - 主屏只回答「我现在安全吗」，其余信息是若干行，细节下沉一层；
   *   - 颜色只用在**出问题的那一行**，健康行不给徽章；
   *   - 行用共享 uiAccordion（原生 <details>），页面不写任何 focus/keydown 逻辑。
   *
   * 刻意**不**包含「检查来源与完整性」：hero 已经在展示扫描器/引擎/规则包/规则条数/
   * 完整性，再留一行就是同一信息两处出现。原先记录的逐行「扫描方式 / 隔离状态」
   * 同样每行都一样，移入了技能详情抽屉。
   */
  function protectionRowsHtml() {
    const st = state.status || {};
    const counts = receiptCounts();
    const caps = st.capabilities || [];
    const attention = caps.filter((c) => c.status !== 'implemented');
    const comp = state.composition;
    const paths = (comp && comp.paths) || [];

    // 文案必须和右侧胶囊说同一件事：原来只要 blocked==0 就说「无异常」，
    // 于是出现「60 个已检查 · 无异常」旁边挂着「需要留意」的矛盾。
    const skillsStatus = counts.blocked > 0
      ? t('settings.security.row_status_skills', { checked: state.receipts.length, blocked: counts.blocked })
      : (counts.risk > 0
        ? t('settings.security.row_status_skills_risk', { checked: state.receipts.length, risk: counts.risk })
        : t('settings.security.row_status_skills_clean', { checked: state.receipts.length }));
    const coverageStatus = caps.length
      ? (attention.length
        ? t('settings.security.row_status_coverage', { ok: caps.length - attention.length, attention: attention.length })
        : t('settings.security.row_status_coverage_clean', { ok: caps.length }))
      : t('settings.security.scanner_not_present_sub');
    const compositionStatus = !comp
      ? t('settings.security.row_status_composition_idle')
      : (paths.length
        ? t('settings.security.row_status_composition_paths', { n: paths.length })
        : t('settings.security.row_status_composition_clean'));

    // 只有需要注意的行才给胶囊；健康行的 statusHtml 是纯文字。
    const pill = (label, tone) => ui('uiStatusPill', { label, tone });
    const plain = (label) => `<span>${esc(label)}</span>`;

    const items = [
      {
        title: t('settings.security.row_skills'),
        icon: 'shield-check',
        tone: counts.blocked > 0 ? TONE_CRITICAL : (counts.risk > 0 ? TONE_ATTENTION : ''),
        statusHtml: counts.blocked > 0
          ? `${plain(skillsStatus)}${pill(t('settings.security.row_tone_critical'), TONE_CRITICAL)}`
          : (counts.risk > 0
            ? `${plain(skillsStatus)}${pill(t('settings.security.row_tone_attention'), TONE_ATTENTION)}`
            : plain(skillsStatus)),
        open: state.openRow === 'skills',
        bodyHtml: receiptsBodyHtml(),
      },
      {
        title: t('settings.security.row_coverage'),
        icon: 'search',
        tone: attention.length ? TONE_ATTENTION : '',
        statusHtml: attention.length
          ? `${plain(coverageStatus)}${pill(t('settings.security.row_tone_attention'), TONE_ATTENTION)}`
          : plain(coverageStatus),
        open: state.openRow === 'coverage',
        bodyHtml: coverageBodyHtml(),
      },
      {
        title: t('settings.security.row_composition'),
        icon: 'git-branch',
        tone: paths.length ? TONE_ATTENTION : '',
        statusHtml: plain(compositionStatus),
        open: state.openRow === 'composition',
        bodyHtml: compositionBodyHtml(),
      },
    ];

    return `<section class="sec-section">
      <h3 class="sec-section-label">${esc(t('settings.security.section_protection'))}</h3>
      ${ui('uiAccordion', { items, defaultOpen: [] })}
    </section>`;
  }

  function loadingHtml() {
    return `<div class="sec-loading">
      ${ui('uiSkeleton', { ariaLabel: t('settings.security.loading'), lines: [40, 92, 76] })}
      ${ui('uiSkeleton', { ariaLabel: t('settings.security.loading'), lines: [100, 100, 88, 64] })}
    </div>`;
  }

  function render() {
    const body = $('#settings-security-body');
    if (!body) return;
    if (state.loading && !state.status) {
      body.innerHTML = loadingHtml();
      return;
    }
    const kind = heroKind();
    body.innerHTML = `
      ${heroHtml(kind)}
      ${issuesHtml(kind)}
      ${protectionRowsHtml()}
      <div class="sec-protect">
        <span class="sec-protect-icon" aria-hidden="true">${icon('lock', 'ui-icon')}</span>
        <span>${esc(t('settings.security.protection_sub'))}</span>
      </div>
      <div class="sec-live" role="status" aria-live="polite">${esc(state.liveMessage)}</div>`;
    wire();
  }

  // ── 详情抽屉 ────────────────────────────────────────────────────────────

  function scoreBreakdownHtml(bd) {
    if (!bd || !(bd.byCategory || []).length) return '';
    const rows = bd.byCategory.filter((c) => c.penalty > 0);
    if (!rows.length) return '';
    return `<section class="sec-drawer-section">
      <h4 class="sec-drawer-title">${esc(t('settings.security.breakdown_title'))}</h4>
      <p class="sec-drawer-sub">${esc(t('settings.security.breakdown_sub', {
        raw: bd.rawPenalty, penalty: bd.penalty,
      }))}</p>
      <ul class="sec-breakdown">
        ${rows.map((c) => `<li>
          <span class="sec-breakdown-name">${esc(t(`settings.security.cat_${c.category}`) === `settings.security.cat_${c.category}` ? c.category : t(`settings.security.cat_${c.category}`))}</span>
          <span class="sec-breakdown-bar"><i style="width:${Math.max(3, Math.min(100, (c.penalty / Math.max(1, bd.penalty)) * 100))}%"></i></span>
          <span class="sec-breakdown-num">-${esc(String(c.penalty))}${c.capped ? esc(t('settings.security.breakdown_capped')) : ''}</span>
          <span class="sec-breakdown-count">${esc(t('settings.security.breakdown_hits', { n: c.count }))}</span>
        </li>`).join('')}
      </ul>
      ${(bd.floors || []).length ? `<p class="sec-drawer-note">${esc(t('settings.security.breakdown_floor', {
        floors: bd.floors.map((f) => t(`settings.security.floor_${f}`)).join('、'),
      }))}</p>` : ''}
    </section>`;
  }

  function frameworkHtml(fw) {
    if (!fw) return '';
    const groups = [
      { label: t('settings.security.framework_ast'), items: fw.owaspAst || [] },
      { label: t('settings.security.framework_llm'), items: fw.owaspLlm || [] },
      { label: t('settings.security.framework_agentic'), items: fw.owaspAgentic || [] },
    ].filter((g) => g.items.length);
    if (!groups.length) return '';
    return `<section class="sec-drawer-section">
      <h4 class="sec-drawer-title">${esc(t('settings.security.framework_title'))}</h4>
      <p class="sec-drawer-sub">${esc(t('settings.security.framework_sub'))}</p>
      ${groups.map((g) => `<div class="sec-framework-group">
        <div class="sec-framework-label">${esc(g.label)}</div>
        <div class="sec-framework-tags">
          ${g.items.map((item) => ui('uiTag', {
            label: `${item.id} · ${item.count}`, variant: 'accent',
            attrs: { title: item.title || item.id },
          })).join('')}
        </div>
      </div>`).join('')}
    </section>`;
  }

  function findingCard(f, acceptances) {
    const loc = f.line ? `${f.file}:${f.line}` : f.file;
    const accepted = (acceptances || []).find((a) => a.fingerprint === f.fingerprint);
    const tags = [
      ...f.cwe.map((c) => ui('uiTag', { label: c })),
      ...f.owaspLlm.map((c) => ui('uiTag', { label: `OWASP ${c}` })),
      ...f.owaspAgentic.map((c) => ui('uiTag', { label: c })),
      ...(f.owaspAst || []).map((c) => ui('uiTag', { label: c })),
    ].join(' ');
    return `<li class="sec-finding" data-severity="${esc(f.severity)}" data-suppressed="${f.suppressed ? '1' : '0'}">
      <div class="sec-finding-head">
        ${ui('uiStatusPill', { label: sevLabel(f.severity), tone: sevTone(f.severity) })}
        <span class="sec-finding-rule">${esc(f.ruleId)}</span>
        <span class="sec-finding-loc">${esc(loc)}</span>
        ${f.hardBlock ? ui('uiBadge', { label: t('settings.security.badge_hard_block'), tone: TONE_CRITICAL }) : ''}
        ${f.demoted ? ui('uiBadge', {
          label: t('settings.security.badge_demoted', { level: sevLabel(f.originalSeverity) }), tone: TONE_NEUTRAL,
        }) : ''}
        ${f.suppressed ? ui('uiBadge', { label: t('settings.security.badge_suppressed'), tone: TONE_NEUTRAL }) : ''}
        ${f.derived ? ui('uiBadge', {
          label: t(`settings.security.derived_${f.derived}`) === `settings.security.derived_${f.derived}`
            ? t('settings.security.derived_generic', { view: f.derived })
            : t(`settings.security.derived_${f.derived}`),
          tone: TONE_ATTENTION,
        }) : ''}
        ${f.suppressionRefused ? ui('uiBadge', {
          label: t('settings.security.badge_suppression_refused'), tone: TONE_CRITICAL,
        }) : ''}
      </div>
      <p class="sec-finding-desc">${esc(f.description)}</p>
      ${tags ? `<div class="sec-finding-tags">${tags}</div>` : ''}
      <dl class="sec-finding-meta">
        <div><dt>${esc(t('settings.security.field_confidence'))}</dt><dd>${esc(t(`settings.security.conf_${f.confidence}`))}</dd></div>
        <div><dt>${esc(t('settings.security.field_context'))}</dt><dd>${esc(t(`settings.security.ctx_${f.context}`) === `settings.security.ctx_${f.context}` ? f.context : t(`settings.security.ctx_${f.context}`))}</dd></div>
        <div><dt>${esc(t('settings.security.field_category'))}</dt><dd>${esc(f.category)}</dd></div>
      </dl>
      ${f.remediation ? `<div class="sec-finding-fix">
        <span class="sec-finding-fix-label">${esc(t('settings.security.field_remediation'))}</span>
        <span>${esc(f.remediation)}</span>
      </div>` : ''}
      ${f.references && f.references.length
        ? `<div class="sec-finding-refs">${f.references.slice(0, 3).map((url) =>
          `<a href="${esc(url)}" target="_blank" rel="noreferrer noopener">${esc(url.replace(/^https?:\/\//, ''))}</a>`).join('')}</div>`
        : ''}
      <div class="sec-finding-actions">
        ${findingAcceptAction(f, accepted)}
      </div>
    </li>`;
  }

  /**
   * 「接受风险」这一行的取值。
   *
   * 高危与一票否决**不提供**接受入口，并说明原因——引擎会拒绝抑制它们
   * （`UNSUPPRESSIBLE_SEVERITIES`）。给一个点了没用的按钮比不给更糟：
   * 用户会以为功能坏了，而不再相信这一节里的任何提示。
   */
  function findingAcceptAction(f, accepted) {
    const blocked = f.hardBlock || f.severity === 'critical' || f.severity === 'high';
    if (f.suppressed) {
      return `${accepted ? `<span class="sec-finding-accepted">${esc(t('settings.security.accepted_until', { time: fmtTime(accepted.expiresAt) }))}${accepted.reason ? ` · ${esc(accepted.reason)}` : ''}</span>` : ''}
        ${ui('uiButton', {
        label: t('settings.security.revoke_accept'), role: 'ghost', size: 'sm', className: 'sec-link',
        attrs: { 'data-action': 'revoke', 'data-fingerprint': f.fingerprint },
      })}`;
    }
    if (f.suppressionRefused) {
      return `<span class="sec-finding-accepted">${esc(t('settings.security.accept_refused_note'))}</span>`;
    }
    // 外部技能（Claude Code / Codex）只做只读扫描：接受记录会写进该技能自己的
    // 目录，那不是我们的目录。主进程也会拒绝，这里不显示点了必然失败的按钮。
    if (state.drawer && state.drawer.evidence && state.drawer.evidence.externalSkill) {
      return `<span class="sec-finding-accepted">${esc(t('settings.security.accept_external_readonly'))}</span>`;
    }
    if (blocked) {
      return `<span class="sec-finding-accepted">${esc(t('settings.security.accept_unavailable'))}</span>`;
    }
    return ui('uiButton', {
      label: t('settings.security.accept_risk'), role: 'ghost', size: 'sm', className: 'sec-link',
      attrs: {
        'data-action': 'accept', 'data-fingerprint': f.fingerprint,
        'data-rule': f.ruleId, 'data-file': f.file, 'data-severity': f.severity,
      },
    });
  }

  function drawerBodyHtml() {
    const d = state.drawer;
    if (!d) return '';
    if (d.loading) {
      const stages = [
        t('settings.security.progress_rules'),
        t('settings.security.progress_text'),
        t('settings.security.progress_binary'),
        t('settings.security.progress_deps'),
        t('settings.security.progress_instruction'),
      ];
      return `<div class="sec-drawer-loading">
        ${ui('uiProgressBar', { ariaLabel: t('settings.security.progress_aria'), value: 40, max: 100 })}
        <ol class="sec-stages">${stages.map((s, i) =>
          `<li class="${i === 0 ? 'is-active' : ''}">${esc(s)}</li>`).join('')}</ol>
        ${ui('uiSkeleton', { ariaLabel: t('settings.security.loading'), lines: [70, 100, 92, 60] })}
      </div>`;
    }
    if (d.error || !d.evidence) {
      return ui('uiEmptyState', {
        kind: 'explained',
        title: t('settings.security.detail_failed'),
        hint: t(`settings.security.detail_failed_${d.error || 'scan_failed'}`) === `settings.security.detail_failed_${d.error || 'scan_failed'}`
          ? t('settings.security.detail_failed_hint')
          : t(`settings.security.detail_failed_${d.error || 'scan_failed'}`),
        icon: 'warning',
      });
    }
    const e = d.evidence;
    const counts = e.severityCounts || {};
    const acceptances = d.acceptances || [];
    const sevFilter = d.filter || 'all';
    let findings = (e.findings || []).slice().sort((a, b) =>
      (SEV_ORDER[b.severity] - SEV_ORDER[a.severity]) || a.file.localeCompare(b.file));
    if (sevFilter === 'active') findings = findings.filter((f) => !f.suppressed);
    else if (sevFilter === 'suppressed') findings = findings.filter((f) => f.suppressed);
    else if (sevFilter !== 'all') findings = findings.filter((f) => f.severity === sevFilter);

    const verdictTone = e.hardBlocked || e.confirmedCritical ? TONE_CRITICAL
      : e.outcome === 'pass' ? TONE_SUCCESS
        : e.outcome === 'restricted' ? TONE_ATTENTION : TONE_NEUTRAL;
    const verdictLabel = e.hardBlocked ? t('settings.security.verdict_hard_blocked')
      : e.confirmedCritical ? t('settings.security.verdict_confirmed_critical')
        : e.outcome === 'pass' ? t('settings.security.decision_pass')
          : e.outcome === 'restricted' ? t('settings.security.decision_risk')
            : e.outcome === 'blocked' ? t('settings.security.decision_blocked')
              : t('settings.security.decision_unknown');

    const notices = [];
    if (e.rulesDegraded) notices.push(t('settings.security.notice_rules_degraded'));
    if (!e.isolated) notices.push(t('settings.security.notice_not_isolated'));
    if (e.coverage && !e.coverage.rulesetResolved) notices.push(t('settings.security.notice_ruleset_unresolved'));
    if (e.coverage && (e.coverage.invalidRules || []).length) {
      notices.push(t('settings.security.notice_invalid_rules', { n: e.coverage.invalidRules.length }));
    }
    if (e.coverage && (e.coverage.derivedFindings || 0) > 0) {
      notices.push(t('settings.security.notice_derived', {
        n: e.coverage.derivedFindings,
        views: Object.keys(e.coverage.derivedViews || {}).join('、'),
      }));
    }
    if (e.coverage && e.coverage.externalTools
      && Object.values(e.coverage.externalTools).some((v) => v && v !== 'OK' && v !== 'static-only')) {
      notices.push(t('settings.security.notice_external_tools'));
    }

    return `
      <div class="sec-drawer-hero">
        ${scoreRing(e.score, 'sm')}
        <div class="sec-drawer-hero-main">
          <div class="sec-drawer-verdict">
            ${ui('uiStatusPill', { label: verdictLabel, tone: verdictTone })}
            ${ui('uiTag', {
              label: e.scanTier === 'sandboxed'
                ? t('settings.security.tier_sandboxed')
                : t('settings.security.tier_static'),
              variant: e.scanTier === 'sandboxed' ? 'success' : 'outline',
            })}
          </div>
          <dl class="sec-drawer-meta">
            <div><dt>${esc(t('settings.security.field_scanned_at'))}</dt><dd>${esc(fmtTime(e.scannedAt))}</dd></div>
            ${e.scannerVersion ? `<div><dt>${esc(t('settings.security.sentry_engine'))}</dt><dd>${esc(e.scannerVersion)}</dd></div>` : ''}
            ${e.rulesetVersion ? `<div><dt>${esc(t('settings.security.ruleset'))}</dt><dd>${esc(e.rulesetVersion)}</dd></div>` : ''}
            ${e.recommendation ? `<div><dt>${esc(t('settings.security.field_recommendation'))}</dt><dd>${esc(e.recommendation)}</dd></div>` : ''}
          </dl>
        </div>
      </div>
      ${e.outcome === 'unknown'
        ? `<div class="sec-drawer-alert">${esc(t('settings.security.unavailable_detail', {
          reason: e.unavailableReason || 'unknown',
        }))}</div>` : ''}
      ${notices.length ? `<ul class="sec-drawer-notices">${notices.map((n) =>
        `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      <div class="sec-sevbar" role="group" aria-label="${esc(t('settings.security.sev_filter_aria'))}">
        ${ui('uiSegmentedControl', {
          ariaLabel: t('settings.security.sev_filter_aria'),
          value: sevFilter,
          items: [
            { label: t('settings.security.filter_all'), value: 'all', count: (e.findings || []).length },
            { label: t('settings.security.filter_active'), value: 'active',
              count: (e.findings || []).filter((f) => !f.suppressed).length },
            ...SEVERITIES.filter((s) => (counts[s] || 0) > 0).map((s) => ({
              label: sevLabel(s), value: s, count: counts[s],
            })),
            ...(acceptances.length ? [{
              label: t('settings.security.filter_suppressed'), value: 'suppressed',
              count: (e.findings || []).filter((f) => f.suppressed).length,
            }] : []),
          ],
          attrs: { 'data-role': 'sev-filter' },
        })}
      </div>
      ${findings.length
        ? `<ul class="sec-findings">${findings.map((f) => findingCard(f, acceptances)).join('')}</ul>`
        : ui('uiEmptyState', {
          kind: 'quiet',
          title: sevFilter === 'all' ? t('settings.security.no_findings') : t('settings.security.no_findings_filtered'),
        })}
      ${scoreBreakdownHtml(e.scoreBreakdown)}
      ${frameworkHtml(e.frameworkSummary)}
      ${coverageDetailHtml(e)}
      ${structuralHtml(e)}
      ${dependenciesHtml(e)}
      ${limitationsHtml(e)}
      ${exportHtml()}`;
  }

  function coverageDetailHtml(e) {
    const c = e.coverage;
    if (!c) return '';
    const rows = [
      [t('settings.security.cov_files'), String(c.filesScanned)],
      [t('settings.security.cov_bytes'), fmtBytes(c.bytesScanned)],
      [t('settings.security.cov_rules'), String(c.ruleCount)],
      [t('settings.security.cov_groups'), String((c.ruleGroups || []).length)],
      [t('settings.security.cov_hard_block'), String(c.hardBlockRules)],
      [t('settings.security.cov_ruleset'), c.rulesetResolved ? (c.rulesetVersion || '—') : t('settings.security.cov_builtin')],
      [t('settings.security.cov_gitleaks'), String((c.externalTools || {}).gitleaks || '—')],
      [t('settings.security.cov_osv'), String((c.externalTools || {}).osv_scanner || '—')],
      [t('settings.security.cov_views'), String(Object.keys(c.derivedViews || {}).length)],
      [t('settings.security.cov_tier'), c.scanTier === 'sandboxed'
        ? t('settings.security.tier_sandboxed') : t('settings.security.tier_static')],
    ];
    return `<section class="sec-drawer-section">
      <h4 class="sec-drawer-title">${esc(t('settings.security.coverage_detail_title'))}</h4>
      <dl class="sec-kv">${rows.map(([k, v]) =>
        `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      ${(c.invalidRules || []).length
        ? `<div class="sec-drawer-alert">${esc(t('settings.security.invalid_rules_detail', {
          list: c.invalidRules.map((r) => `${r.id}(${r.where})`).join(', '),
        }))}</div>` : ''}
    </section>`;
  }

  function structuralHtml(e) {
    const s = e.structuralSummary;
    if (!s || !s.fileCount) return '';
    return `<section class="sec-drawer-section">
      <h4 class="sec-drawer-title">${esc(t('settings.security.structural_title'))}</h4>
      <dl class="sec-kv">
        <div><dt>${esc(t('settings.security.structural_files'))}</dt><dd>${esc(String(s.fileCount))}</dd></div>
        <div><dt>${esc(t('settings.security.structural_size'))}</dt><dd>${esc(fmtBytes(s.totalBytes))}</dd></div>
        <div><dt>${esc(t('settings.security.structural_exec'))}</dt><dd>${esc(String(s.executableCount || 0))}</dd></div>
        <div><dt>${esc(t('settings.security.structural_archives'))}</dt><dd>${esc(String(s.archiveCount || 0))}</dd></div>
      </dl>
      ${(s.topExtensions || []).length ? `<div class="sec-tags">${s.topExtensions.map((x) =>
        ui('uiTag', { label: `${x.ext} × ${x.count}` })).join('')}</div>` : ''}
    </section>`;
  }

  function dependenciesHtml(e) {
    const m = e.dependencyManifests;
    if (!m) return '';
    const packages = Array.isArray(m.runtime_packages) ? m.runtime_packages : [];
    const deps = Array.isArray(m.npm_dependencies) ? m.npm_dependencies : [];
    const hooks = m.npm_hooks && typeof m.npm_hooks === 'object' ? Object.keys(m.npm_hooks) : [];
    if (!packages.length && !deps.length && !hooks.length) return '';
    return `<section class="sec-drawer-section">
      <h4 class="sec-drawer-title">${esc(t('settings.security.deps_title'))}</h4>
      ${hooks.length ? `<p class="sec-drawer-note">${esc(t('settings.security.deps_hooks', { list: hooks.join(', ') }))}</p>` : ''}
      ${deps.length ? `<div class="sec-tags">${deps.slice(0, 30).map((d) =>
        ui('uiTag', { label: d })).join('')}</div>` : ''}
      ${packages.length ? `<p class="sec-drawer-sub">${esc(t('settings.security.deps_runtime'))}</p>
        <div class="sec-tags">${packages.slice(0, 30).map((d) =>
          ui('uiTag', { label: d })).join('')}</div>` : ''}
    </section>`;
  }

  function limitationsHtml(e) {
    if (!(e.limitations || []).length) return '';
    return `<section class="sec-drawer-section">
      <h4 class="sec-drawer-title">${esc(t('settings.security.limitations_title'))}</h4>
      <ul class="sec-limitations">${e.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    </section>`;
  }

  function exportHtml() {
    const formats = [
      ['json', 'JSON'],
      ['sarif', 'SARIF'],
      ['markdown', 'Markdown'],
      ['csv', 'CSV'],
    ];
    return `<section class="sec-drawer-section">
      <h4 class="sec-drawer-title">${esc(t('settings.security.export_title'))}</h4>
      <p class="sec-drawer-sub">${esc(t('settings.security.export_sub'))}</p>
      <div class="sec-export-row">
        ${formats.map(([format, label]) => ui('uiButton', {
          label, size: 'sm',
          attrs: { 'data-action': 'export-report', 'data-format': format },
        })).join('')}
      </div>
    </section>`;
  }

  function openDrawer(skillId) {
    const existing = state.drawer && state.drawer.controller;
    if (existing) existing.close('replaced');
    state.drawer = {
      skillId, loading: true, evidence: null, error: null, filter: 'all', acceptances: [],
      controller: null,
    };
    const controller = ui('uiDrawer', {
      title: t('settings.security.drawer_title', { skill: skillId }),
      bodyHtml: drawerBodyHtml(),
      closeLabel: t('common.close'),
      onClose() {
        if (state.drawer && state.drawer.skillId === skillId) state.drawer = null;
      },
    });
    if (!controller) {
      // The shared drawer refuses to build without a DOM or its icon button.
      // Falling back to a toast keeps the failure visible instead of silent.
      ui('uiToast', t('settings.security.drawer_unavailable'), { variant: 'warning' });
      state.drawer = null;
      return;
    }
    state.drawer.controller = controller;
    wireDrawer();
    loadDrawer(skillId);
  }

  function rerenderDrawer() {
    const d = state.drawer;
    if (!d || !d.controller) return;
    const body = d.controller.drawer && d.controller.drawer.querySelector('.ui-drawer__body');
    if (!body) return;
    const scrollTop = body.scrollTop;
    body.innerHTML = drawerBodyHtml();
    body.scrollTop = scrollTop;
    wireDrawer();
  }

  async function loadDrawer(skillId) {
    const d = state.drawer;
    if (!d || d.skillId !== skillId) return;
    d.loading = true;
    d.error = null;
    rerenderDrawer();
    try {
      const [report, acc] = await Promise.all([
        window.cogseed.invoke('skills.security.report', { skillId }),
        window.cogseed.invoke('skills.security.acceptances', { skillId }).catch(() => ({ acceptances: [] })),
      ]);
      if (!state.drawer || state.drawer.skillId !== skillId) return;
      if (!report || report.ok === false) {
        state.drawer.loading = false;
        state.drawer.error = (report && report.reason) || 'scan_failed';
      } else {
        state.drawer.evidence = report.evidence;
        state.drawer.acceptances = (acc && acc.acceptances) || [];
        state.drawer.loading = false;
      }
    } catch (err) {
      if (!state.drawer || state.drawer.skillId !== skillId) return;
      state.drawer.loading = false;
      state.drawer.error = (err && err.message) || 'scan_failed';
    }
    rerenderDrawer();
  }

  function wireDrawer() {
    const d = state.drawer;
    if (!d || !d.controller) return;
    const body = d.controller.drawer && d.controller.drawer.querySelector('.ui-drawer__body');
    if (!body || body.dataset.wired === '1') {
      if (body) body.dataset.wired = '1';
      return;
    }
    body.dataset.wired = '1';
    body.addEventListener('click', async (ev) => {
      const filterBtn = ev.target.closest('[data-role="sev-filter"] button');
      if (filterBtn) {
        const label = filterBtn.querySelector('.ui-segmented-control__label');
        const next = label ? label.textContent : '';
        // The segmented control renders labels, not values; map back through the
        // same table the renderer used so the two cannot drift.
        state.drawer.filter = filterValueFromLabel(next);
        rerenderDrawer();
        return;
      }
      const el = ev.target.closest('[data-action]');
      if (!el || !state.drawer) return;
      const action = el.dataset.action;
      if (action === 'accept') {
        await acceptRisk(el.dataset.fingerprint, el.dataset.rule, el.dataset.file, el.dataset.severity);
      } else if (action === 'revoke') {
        await revokeRisk(el.dataset.fingerprint);
      } else if (action === 'export-report') {
        await exportReport(el.dataset.format);
      }
    });
  }

  /** Maps a segmented-control label back to its filter value. */
  function filterValueFromLabel(label) {
    const text = String(label || '');
    if (text === t('settings.security.filter_all')) return 'all';
    if (text === t('settings.security.filter_active')) return 'active';
    if (text === t('settings.security.filter_suppressed')) return 'suppressed';
    // 库级筛选与发现项筛选共用同一个分段控件工厂，因此标签→取值要认识两套词。
    if (text === t('settings.security.stat_pass')) return 'pass';
    if (text === t('settings.security.stat_risk')) return 'risk';
    if (text === t('settings.security.stat_declaration')) return 'declaration';
    if (text === t('settings.security.stat_blocked')) return 'blocked';
    if (text === t('settings.security.stat_unchecked')) return 'unchecked';
    for (const sev of SEVERITIES) {
      if (text === sevLabel(sev)) return sev;
    }
    return 'all';
  }

  async function acceptRisk(fingerprint, ruleId, file, severity) {
    const d = state.drawer;
    if (!d || !fingerprint) return;
    const input = await ui('uiPrompt', t('settings.security.accept_prompt', { rule: ruleId || '' }));
    if (input === null) return;
    const reason = String(input || '').trim();
    if (reason.length < 4) {
      ui('uiToast', t('settings.security.accept_reason_required'), { variant: 'warning' });
      return;
    }
    const daysInput = await ui('uiPrompt', t('settings.security.accept_days_prompt'));
    if (daysInput === null) return;
    const days = Math.floor(Number(daysInput));
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      ui('uiToast', t('settings.security.accept_days_invalid'), { variant: 'warning' });
      return;
    }
    const confirmOk = await ui('uiConfirm', {
      title: t('settings.security.accept_confirm_title'),
      message: t('settings.security.accept_confirm_body', { days, reason, rule: ruleId || '' }),
      confirmLabel: t('settings.security.accept_risk'),
      cancelLabel: t('common.cancel'),
    });
    if (confirmOk !== true) return;
    const res = await window.cogseed.invoke('skills.security.accept', {
      skillId: d.skillId, fingerprint, ruleId: ruleId || '', file: file || '',
      reason, days, severity: severity || '',
    });
    if (!res || res.ok === false) {
      ui('uiToast', t(`settings.security.accept_error_${(res && res.error) || 'write_failed'}`) === `settings.security.accept_error_${(res && res.error) || 'write_failed'}`
        ? t('settings.security.accept_error_generic')
        : t(`settings.security.accept_error_${(res && res.error) || 'write_failed'}`), { variant: 'warning' });
      return;
    }
    setLive(t('settings.security.accept_done'));
    await loadDrawer(d.skillId);
    await refreshReceipts();
  }

  async function revokeRisk(fingerprint) {
    const d = state.drawer;
    if (!d || !fingerprint) return;
    const res = await window.cogseed.invoke('skills.security.revoke', {
      skillId: d.skillId, fingerprint,
    });
    if (!res || res.ok === false) {
      ui('uiToast', t('settings.security.revoke_error'), { variant: 'warning' });
      return;
    }
    setLive(t('settings.security.revoke_done'));
    await loadDrawer(d.skillId);
    await refreshReceipts();
  }

  async function exportReport(format) {
    const d = state.drawer;
    if (!d) return;
    try {
      const res = await window.cogseed.invoke('skills.security.export', {
        skillId: d.skillId, format: format || 'json',
      });
      if (!res || res.ok === false) {
        ui('uiToast', t('settings.security.export_failed'), { variant: 'warning' });
        return;
      }
      downloadText(res.content, res.filename, res.mime);
      ui('uiToast', t('settings.security.export_done', { name: res.filename }), { variant: 'success' });
    } catch (_) {
      ui('uiToast', t('settings.security.export_failed'), { variant: 'warning' });
    }
  }

  function downloadText(content, filename, mime) {
    const blob = new Blob([content], { type: mime || 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename || 'cogseed-security.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ── 数据加载与动作 ────────────────────────────────────────────────────────
  async function refreshReceipts() {
    try {
      const r = await window.cogseed.invoke('skills.trust.list', {});
      state.receipts = Array.isArray(r && r.receipts) ? r.receipts : [];
    } catch (_) { /* keep old */ }
    render();
  }

  async function loadAll() {
    // First load shows skeletons; re-entry refreshes silently
    // (stale-while-revalidate) so an engine install/restore or a rescan shows
    // up the next time the user opens the tab instead of staying on the
    // snapshot from the first visit.
    if (!state.status) {
      state.loading = true;
      render();
    }
    const [statusRes, trustRes, skillsRes] = await Promise.allSettled([
      window.cogseed.invoke('skills.security.status', {}),
      window.cogseed.invoke('skills.trust.list', {}),
      window.cogseed.invoke('skills.list', {}),
    ]);
    state.status = statusRes.status === 'fulfilled'
      ? ((statusRes.value && statusRes.value.status) || null) : null;
    state.receipts = trustRes.status === 'fulfilled' && Array.isArray(trustRes.value && trustRes.value.receipts)
      ? trustRes.value.receipts : [];
    state.skills = skillsRes.status === 'fulfilled' && Array.isArray(skillsRes.value && skillsRes.value.skills)
      ? skillsRes.value.skills : [];
    state.loading = false;
    render();
    setLive(t('settings.security.status_loaded'));
  }

  function setLive(message) {
    state.liveMessage = message;
    const el = document.querySelector('#settings-security-body .sec-live');
    if (el) el.textContent = message;
  }

  /**
   * 重新检查一个技能，并把结果说出来。
   *
   * 这里踩过两个坑，都属于「点了没反应」：
   *  1. `render()` 只重画 `#settings-security-body`，而选择器抽屉挂在
   *     `document.body` 上——所以正在检查的按钮永远不显示 loading，
   *     `setLive` 写进的行内 live region 也被抽屉盖住、用户看不见。
   *  2. IPC 的错误是**数据**不是异常（`{ ok:false, error }`），所以只写
   *     `catch` 等于把主进程的失败也吞掉，连 toast 都不会出现。
   *
   * 结果分三种，都必须说清楚：真的重扫了（附新结论）、结论已是最新无需重扫、
   * 以及失败。收尾的 toast 用共享 `uiToast`（层序在抽屉之上）。
   */
  async function recheckSkill(skillId) {
    state.checking.add(skillId);
    render();
    // 抽屉不在页面里，必须单独刷新，否则看不到「检查中…」。
    refreshPickerList();
    setLive(t('settings.security.checking_live', { skill: skillId }));
    let outcome = 'failed';
    try {
      const res = await window.cogseed.invoke('skills.trust.reverify', { skillId });
      if (!res || res.ok === false) {
        outcome = 'failed';
      } else {
        // `rescanned` 由主进程给出：false 表示回执仍然适用（内容与规则包都没变），
        // 这时说「已检查」会让人以为重扫过，所以单独一句话。
        outcome = (res.result && res.result.rescanned) ? 'rescanned' : 'current';
      }
    } catch (_) {
      // A failed recheck keeps the old record — the next full refresh retries.
      outcome = 'failed';
    }
    state.checking.delete(skillId);
    try {
      await refreshReceipts();
    } catch (_) { /* 刷新失败也必须给出反馈，不能因此静默 */ }
    refreshPickerList();
    // 结论文案带上**刷新后**的判定，否则用户只能靠对比两行文字。
    const fresh = state.receipts.find((r) => r.skillId === skillId);
    const label = outcome === 'failed'
      ? t('settings.security.recheck_failed', { skill: skillId })
      : outcome === 'rescanned'
        ? t('settings.security.recheck_done_result', {
          skill: skillId, verdict: fresh ? receiptDecisionText(fresh) : '',
        })
        : t('settings.security.recheck_done_current', { skill: skillId });
    setLive(label);
    ui('uiToast', label, {
      variant: outcome === 'failed' ? 'error' : (outcome === 'rescanned' ? 'success' : 'info'),
    });
  }

  function exportReceipts() {
    const payload = state.receipts.map((r) => ({
      skillId: r.skillId,
      decision: r.decision,
      scannedAt: r.scannedAt,
      securityScore: r.securityScore,
      scanner: r.scanner,
      scannerVersion: r.scannerVersion,
      rulesetVersion: r.rulesetVersion,
      isolated: r.isolated,
      rulesDegraded: r.rulesDegraded,
      attackSurface: r.attackSurface,
      dependencyHash: r.dependencyHash,
      permissionHash: r.permissionHash,
      violationCount: r.violationCount,
      topRule: r.topRule,
      topLevel: r.topLevel,
    }));
    downloadText(JSON.stringify(payload, null, 2), 'cogseed-security-receipts.json', 'application/json');
    ui('uiToast', t('settings.security.export_done', { name: 'cogseed-security-receipts.json' }),
      { variant: 'success' });
  }

  async function runComposition() {
    if (state.compositionLoading) return;
    state.compositionLoading = true;
    state.compositionError = null;
    render();
    setLive(t('settings.security.composition_running'));
    try {
      const res = await window.cogseed.invoke('skills.security.composition', {});
      state.composition = res || { skills: [], paths: [], coverage: {} };
    } catch (_) {
      state.compositionError = 'failed';
    }
    state.compositionLoading = false;
    render();
    setLive(t('settings.security.composition_done'));
  }

  function wire() {
    const body = $('#settings-security-body');
    if (!body) return;
    if (body.dataset.securityBound === '1') return;
    body.dataset.securityBound = '1';
    // uiAccordion 用原生 <details>，展开状态由浏览器持有；页面只把它同步回 state，
    // 这样一次 render 之后不会把用户刚展开的行复位。
    body.addEventListener('toggle', (ev) => {
      const item = ev.target.closest && ev.target.closest('.ui-accordion__item');
      if (!item) return;
      const idx = Array.prototype.indexOf.call(
        item.parentElement ? item.parentElement.children : [], item,
      );
      state.openRow = item.open ? (['skills', 'coverage', 'composition'][idx] || null) : null;
    }, true);
    body.addEventListener('click', (ev) => {
      const filterBtn = ev.target.closest('[data-role="library-filter"] button');
      if (filterBtn) {
        const label = filterBtn.querySelector('.ui-segmented-control__label');
        state.filter = filterValueFromLabel(label ? label.textContent : '');
        state.expanded = false;
        render();
        return;
      }
      const el = ev.target.closest('[data-action]');
      if (!el) return;
      const action = el.dataset.action;
      if (action === 'recheck' || action === 'check') {
        const skillId = el.dataset.skill
          || (el.closest('tr') && el.closest('tr').dataset.skill);
        if (skillId) recheckSkill(skillId);
      } else if (action === 'detail') {
        if (el.dataset.skill) openDrawer(el.dataset.skill);
      } else if (action === 'refresh') {
        loadAll();
      } else if (action === 'export') {
        exportReceipts();
      } else if (action === 'toggle-all') {
        state.expanded = !state.expanded;
        render();
      } else if (action === 'run-composition') {
        runComposition();
      } else if (action === 'toggle-coverage') {
        state.coverageExpanded = !state.coverageExpanded;
        render();
      } else if (action === 'toggle-picker') {
        if (state.pickerOpen) closePicker(); else openPicker();
      }
    });
  }

  function initSecuritySettings() {
    const tabBtn = document.querySelector('[data-settings-tab="security"]');
    if (tabBtn) {
      // No one-shot guard: every activation refreshes. Without this the page
      // keeps the status from the first visit — a scanner restored while the
      // app ran stayed "需要留意" until a manual 刷新.
      tabBtn.addEventListener('click', () => loadAll());
    }
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('i18n-change', () => {
      if (state.status) render();
      if (state.drawer && state.drawer.evidence) rerenderDrawer();
      if (state.pickerDrawer) {
        const panelBody = pickerPanelBody(state.pickerDrawer);
        if (panelBody) panelBody.innerHTML = pickerBodyHtml();
      }
    });
  }

  function onReady() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initSecuritySettings);
    } else {
      initSecuritySettings();
    }
  }
  onReady();

  if (typeof window !== 'undefined') {
    window.loadSecuritySettings = loadAll;
    // Test seam: pure render helpers exposed for the renderer integration tests,
    // mirroring how other page modules expose a guarded bridge. Not used in
    // production paths.
    window.__securitySettingsInternals = {
      scoreRing, scoreBand, heroKind, scannerIsFaulty, receiptCounts, libraryScore,
      filterValueFromLabel,
      compositionBodyHtml, findingAcceptAction,
      // 重新检查的反馈与选择器列表都是可见契约（"点了没反应"是真实报障），
      // 抽屉本体需要真实 DOM，所以这两个纯函数留给集成测试直接调用。
      recheckSkill, pickerListHtml, receiptDecisionText, staleReceipts,
      __setState(patch) { Object.assign(state, patch); },
      __getState() { return state; },
      __render: render,
    };
  }
})();
