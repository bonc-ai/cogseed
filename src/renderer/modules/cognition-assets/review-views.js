/* ============================================================================
 * 认知资产 · 视图层：待我处理页（cognition-assets/review-views.js）
 *
 * 2026-09-29 自 views.js 机械拆出（零行为变更）：viewReview 整段迁入。
 * 候选族零件（卡片/清单谓词/异常展开区/候选详情）经 NS.candidate 取用，
 * 共享零件经 NS.ui 取用——本文件必须晚于 review-candidate.js 加载。
 * ========================================================================== */
(function () {
  'use strict';

  const NS = window.CogAssets;
  if (!NS) return;
  const { T, esc, fmtDate } = NS;
  const S = NS.store;
  const { btn, roleBtn, hero, empty, sectionHead, termNote, otherActions } = NS.ui;
  const {
    card: candidateCard,
    viewCandidate,
    pending: candidatePending,
    awaiting: candidateAwaiting,
    evidenceMostlyUnavailable,
    title: candidateTitle,
    sourceIssuesSection,
    taskFailedSection,
  } = NS.candidate;

  /* ────────────────────────── 视图：待我处理 ────────────────────────── */

  function viewReview(route) {
    if (route.candidateId) return viewCandidate(route);
    // A5（2026-09-29）：候选清单读取失败进显式错误态——不再把「没读到」伪装
    // 成「没有要你决定的」空态（此前 soft 降级空数组，用户会误以为清净了）。
    if (S.candidatesError) {
      return `${hero(T('cognition.review_title', '待我处理'), '')}
      <div class="sect-block">${empty(
        T('cognition.review_load_failed_title', '清单没能读取'),
        T('cognition.review_load_failed_hint', '待确认内容的清单没有读到。可以稍后重试；重试仍失败时，重启应用通常能恢复。'),
        { label: T('cognition.review_load_retry', '重试'), attrs: { 'data-act': 'retry-candidates' } },
      )}</div>`;
    }
    const stats = NS.stats();
    // 两线不拆（2026-09-17 二次定调）：KSTAR 提案与对话候选同池确认，
    // 候选卡自带来源徽章（KSTAR 复盘/KSTAR 偏好/会话整理）区分出身。
    // 分组顺序（2026-09-21 原型 v7 契约）：等待确认 → 来源已删 → 证据不足
    // → 已稍后处理 → 终态折叠 → 处理记录折叠——需要行动的组永远排在
    // 低打扰组之前。可操作组（等待/来源已删/证据不足/已稍后）的判定全部
    // 来自后端 capabilities（displayState/isSnoozed），不看本地 status 猜；
    // 终态折叠与处理记录两组读原始 status/displayState——capabilities 只
    // 建模可操作状态（candidate-capabilities 的 displayState 表不含
    // confirmed/rejected/expired 等终态），终态不可变、读原始字段无漂移
    // 风险（2026-09-29 B5 复审校正口径）。
    const pending = S.candidates.filter(candidatePending);
    const displayState = (c) => String(((c || {}).capabilities || {}).displayState || '');
    const awaiting = pending.filter(candidateAwaiting);
    const broken = awaiting.filter(evidenceMostlyUnavailable);
    const weak = awaiting.filter((c) => !evidenceMostlyUnavailable(c) && displayState(c) === 'weak_evidence');
    const ready = awaiting.filter((c) => !evidenceMostlyUnavailable(c) && displayState(c) !== 'weak_evidence');
    const snoozed = pending.filter((c) => c.capabilities && c.capabilities.isSnoozed);
    const terminal = S.candidates.filter((c) => ['expired', 'superseded'].includes(displayState(c)) && !candidatePending(c)).slice(0, 8);
    const processed = S.candidates
      .filter((c) => ['confirmed', 'rejected', 'ignored'].includes(String(c.status || '')))
      .slice(0, 5);
    // 处理结果按真实状态如实显示——此前无论保存还是拒绝都写「已保存」，
    // 与筛选口径（confirmed/rejected/ignored 三种）不符（用户实测抓出）。
    const processedLabel = (c) => ({
      confirmed: T('cognition.candidate_status_promoted', '已保存'),
      rejected: T('cognition.candidate_status_rejected', '未保存'),
      ignored: T('cognition.candidate_status_ignored', '已忽略'),
    }[String(c.status || '')] || T('cognition.candidate_status_other', '已处理'));
    const attention = [];
    // 注：治理待办（cognition.inbox：未分级 / 规则缺边界 / 分类冲突等）曾在此
    // 列出，但新 UI 尚无资产分级与边界编辑入口——报了警却无处处理，只会
    // 制造焦虑（2026-09-14 撤下）。等治理动作入口恢复后，连同每类的动作
    // 指引一起重上。此处只保留有明确处理出口的两条。
    if (stats.sourceIssues) {
      // 来源异常就地展开（2026-09-15：来源健康无常态页，异常驱动）。
      // specs/017 整改二：正文回正文字色——颜色只留给短状态章，不再整句刷黄。
      attention.push(`<div class="notice-row" data-act="toggle-source-issues" ${roleBtn()}><div class="notice-copy"><div class="notice-title">${esc(T('cognition.overview_source_issues', '{count} 条来源记录需要处理', { count: String(stats.sourceIssues) }))}</div></div><span class="sp"></span>${btn(T('common.handle', '处理'), 'toggle-source-issues', { small: true, className: 'o' })}</div>`);
    }
    if (stats.failedTasks) {
      // 落点（2026-09-15）：重试按钮在「整理」页的任务流里。
      attention.push(`<div class="notice-row" data-act="go-organize" ${roleBtn()}><div class="notice-copy"><div class="notice-title">${esc(T('cognition.overview_failed_tasks', '{count} 个整理任务需要重试', { count: String(stats.failedTasks) }))}</div></div><span class="sp"></span>${btn(T('common.handle', '处理'), 'go-organize', { small: true, className: 'o' })}</div>`);
    }
    if (stats.taskFailed) {
      // 任务执行失败（承接表 01 / G1）：与整理失败**分别反馈**——这是任务没跑
      // 出结果（未得到回复），重跑入口在会话本身，不是整理重试。
      // A4（2026-09-29）：此前「处理」按钮跳系统活动页，但那类会话在那边
      // 属低价值排除行、没有任何动作——按钮带你去一个处理不了的地方。
      // 现在就地展开逐条列出，每条给「回到会话」入口（重跑=在会话里再说一次）。
      attention.push(`<div class="notice-row" data-act="toggle-task-failed" ${roleBtn()}><div class="notice-copy"><div class="notice-title">${esc(T('cognition.overview_task_failed', '{count} 个任务执行失败（未得到回复）', { count: String(stats.taskFailed) }))}</div></div><span class="sp"></span>${btn(T('cognition.review_task_failed_open', '看是哪几次'), 'toggle-task-failed', { small: true, className: 'o' })}</div>`);
    }
    // 治理待办 / 待确认清单（2026-09-25 重上，specs/008 T051；2026-09-26 分组呈现，
    // specs/010 T014~T016 / US-301）：分组可用时按「治理待办」分区呈现（顺序由主进程
    // groupCognitionInbox 唯一给出：敏感级与催办三组删除后为 冲突 → 其他）；拿不到
    // groups（旧主进程 / 读失败）时**逐字退回**既有扁平清单。渲染层只渲染读模型给的
    // 动作（`item.actions`），不自己判"哪些动作可用"；取词一律内联 T()。
    const inboxItems = Array.isArray(S.inbox) ? S.inbox : [];
    const inboxGroups = Array.isArray(S.inboxGroups) ? S.inboxGroups : null;
    const INBOX_ACTION_LABELS = {
      accept: T('cognition.inbox_action_accept', '保存'),
      reject: T('cognition.inbox_action_reject', '拒绝'),
      defer: T('cognition.inbox_action_defer', '稍后处理'),
      ignore: T('cognition.inbox_action_ignore', '忽略'),
    };
    const PROPOSAL_ACTION_LABELS = {
      accept: T('cognition.inbox_action_accept_update', '保存更新'),
      defer: T('cognition.inbox_action_defer_later', '稍后处理'),
      reject: T('cognition.inbox_action_reject_proposal', '拒绝'),
    };
    const FINDING_ACTION_LABELS = {
      reject: T('cognition.inbox_action_dismiss', '不管它'),
      defer: T('cognition.inbox_action_look_later', '回头再看'),
    };
    const actionLabelsFor = (kind) => (kind === 'asset_change_pending'
      ? PROPOSAL_ACTION_LABELS
      : kind === 'cleanup_uncertain' || kind === 'inspection_finding' ? FINDING_ACTION_LABELS : INBOX_ACTION_LABELS);
    // 标题一行截断（2026-09-26 真机取证）：inbox 的 title 可能是资产正文全文，
    // 五行大标题把整页压垮；全文进 title 悬浮，行上只给一句能扫的。
    const rowTitle = (row) => {
      const raw = String(row.title || '');
      const cut = raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
      return `<div class="notice-title" title="${esc(raw)}">${esc(cut)}</div>`;
    };
    // 既有扁平行的渲染（降级路径与「其他」组共用，语义不变）。
    // 三件套（specs/018 T011）：首个动作 = 推荐动作（primary 视觉），
    // 其余收「其他处理」折叠；没有一键动作的仍给资产详情落点。
    // A1（2026-09-29）：缺边界规则恢复「就地补条件」表单（specs/010 T028
    // 原口径）——后端处置链与 boundary 预填字段一直都在（inbox-adapter 的
    // set_boundary 分支 + 同一道规则闸门），两页重整只删了前端表单，按钮
    // 裸出工程词且点了必报错。表单按行内 data-f 就地读取，多值用顿号分隔。
    const boundaryFormRow = (row) => {
      const id = String(row.id || '');
      const boundary = row.boundary && typeof row.boundary === 'object' ? row.boundary : {};
      const joinList = (list) => (Array.isArray(list) ? list.map(String).filter(Boolean).join('、') : '');
      const suffix = id.replace(/[^a-z0-9_-]/gi, '');
      return `<div class="notice-row ca-inbox-boundary" data-inbox-boundary-form>
        <div class="notice-copy">
          ${rowTitle(row)}
          <div class="notice-detail">${esc(T('cognition.inbox_rule_boundary_hint', '没写适用范围的规矩不会被自动带入任务；补齐后才会生效。'))}</div>
          <div class="ca-inbox-boundary-form">
            ${window.uiInput({ id: `inbox-boundary-applicable-${suffix}`, value: joinList(boundary.applicableWhen), attrs: { 'data-f': 'boundary-applicable', placeholder: T('cognition.inbox_boundary_field_applicable', '适用情形') } })}
            ${window.uiInput({ id: `inbox-boundary-forbidden-${suffix}`, value: joinList(boundary.forbiddenWhen), attrs: { 'data-f': 'boundary-forbidden', placeholder: T('cognition.inbox_boundary_field_forbidden', '禁用情形') } })}
            <div class="note">${esc(T('cognition.inbox_boundary_save_effect', '保存后：主进程重新校验，通过后这条规则恢复自动带入；不通过会把原因留在这里。'))}</div>
          </div>
        </div>
        <span class="sp"></span>${btn(T('cognition.inbox_boundary_submit', '保存边界'), 'inbox-boundary-save', { small: true, primary: true, data: { id } })}
      </div>`;
    };
    const flatInboxRow = (row) => {
      if (String(row.kind || '') === 'rule_boundary_missing') return boundaryFormRow(row);
      const actions = Array.isArray(row.actions) ? row.actions : [];
      const labels = actionLabelsFor(String(row.kind || ''));
      const [recommended, ...rest] = actions;
      const primaryBtn = recommended
        ? btn(labels[recommended] || String(recommended), 'inbox-resolve', {
          small: true, primary: true, data: { id: String(row.id || ''), action: String(recommended) },
        })
        : '';
      const restBtns = otherActions(rest.map((action) => btn(labels[action] || String(action), 'inbox-resolve', {
        small: true, className: 'o', data: { id: String(row.id || ''), action: String(action) },
      })).join(''));
      // 没有一键动作的：给落点（资产详情里的编辑入口），而不是只报警。
      const fallback = actions.length || !row.assetId
        ? ''
        : btn(T('cognition.inbox_go_asset', '去资产详情处理'), 'go-inbox-asset', { small: true, className: 'o', data: { id: String(row.assetId) } });
      return `<div class="notice-row">
        <div class="notice-copy">${rowTitle(row)}${row.detail ? `<div class="notice-detail">${esc(String(row.detail))}</div>` : ''}</div>
        <span class="sp"></span>${fallback}${primaryBtn}${restBtns}
      </div>`;
    };
    // ── 治理分区的取词（内联，i18n 门禁扫得到；不信任主进程下发的 titleKey）──
    // 组名走人话（specs/018 §4）。敏感级「扩权/未分级」与「缺边界催办」三个
    // 分组已随机制整体删除（2026-09-28 两页重整：待我处理只剩等你拍板的事；
    // 边界的编辑入口保留在资产编辑表单）——主进程分组枚举收窄后这里只剩
    // 冲突与其他；历史残留 category 落 other 兜底、行沿 flatInboxRow。
    const GROUP_TITLES = {
      conflict: T('cognition.inbox_group_conflict', '冲突与重复'),
      other: T('cognition.inbox_group_other', '其他待处理'),
    };
    const GROUP_HINTS = {
      conflict: T('cognition.inbox_classification_conflict_hint', '同一句话被归到两个类型，两边都不会晋升，需要你裁定。'),
    };
    // ── 各分区的行渲染器（动作仍以 item.actions 为准，渲染层不自判）──
    const governanceRow = (row) => {
      const actions = Array.isArray(row.actions) ? row.actions : [];
      const has = (action) => actions.includes(action);
      const id = String(row.id || '');
      // 聚合行的 detail 与组 hint 同文（真机截图取证）：不重复摆第二遍。
      const detail = row.aggregate ? '' : row.detail;
      const head = `<div class="notice-copy">${rowTitle(row)}${detail ? `<div class="notice-detail">${esc(String(detail))}</div>` : ''}</div>`;
      if (row.kind === 'classification_conflict' && has('claim')) {
        return `<div class="notice-row">${head}<span class="sp"></span>${btn(T('cognition.inbox_action_claim', '保留这一条'), 'inbox-conflict-claim', { small: true, primary: true, data: { id } })}${otherActions([has('reject') ? btn(INBOX_ACTION_LABELS.reject, 'inbox-resolve', { small: true, className: 'o', data: { id, action: 'reject' } }) : '', has('defer') ? btn(INBOX_ACTION_LABELS.defer, 'inbox-resolve', { small: true, className: 'o', data: { id, action: 'defer' } }) : ''].join(''))}</div>`;
      }
      if (row.kind === 'inspection_finding' && (has('keep') || has('merge'))) {
        // 巡检冲突/重复（specs/010 T033）：选边归档或合并。目标 = 本行锚定的
        // 资产（data-anchor）；data-target 携带另一方 id（展示与测试锚点）。
        const anchor = String(row.assetId || '');
        const other = String((row.assetIds || []).find((assetId) => String(assetId) !== anchor) || '');
        return `<div class="notice-row">${head}<span class="sp"></span>${has('keep') ? btn(T('cognition.inbox_action_keep', '保留这一条，归档另一条'), 'inbox-inspection-keep', { small: true, primary: true, data: { id, anchor, target: other } }) : ''}${otherActions([has('merge') ? btn(T('cognition.inbox_action_merge_pair', '合并到这一条'), 'inbox-inspection-merge', { small: true, className: 'o', data: { id, anchor, target: other } }) : '', has('reject') ? btn(FINDING_ACTION_LABELS.reject, 'inbox-resolve', { small: true, className: 'o', data: { id, action: 'reject' } }) : '', has('defer') ? btn(FINDING_ACTION_LABELS.defer, 'inbox-resolve', { small: true, className: 'o', data: { id, action: 'defer' } }) : ''].join(''))}</div>`;
      }
      // 其余（含没有就地处断动作的）沿用既有扁平行（落点按钮同现状）。
      return flatInboxRow(row);
    };
    // ── 决策队列（specs/018 v2 · 2026-09-26 真机重做）：后端 urgency
    //（confirm/low_disturbance）决定分区；组名只作区内小节；计数三口径
    // 统一成「要你拍板 / 低打扰 / 证据异常」，与页签角标同一来源。
    const isConfirm = (row) => String(row.urgency || '') === 'confirm';
    const groupBlock = (group, items) => {
      const title = GROUP_TITLES[group.category] || GROUP_TITLES.other;
      const hint = GROUP_HINTS[group.category];
      const rows = items.map((row) => (group.category === 'other' ? flatInboxRow(row) : governanceRow(row))).join('');
      // 计数口径（T016）：显示本拆分区条目数（未分级组「显示 total」的特判
      // 已随分级待办整体删除，2026-09-28）。
      return `<div class="sect-block"><div class="tt">${esc(title)}<span class="note">${esc(String(items.length))}</span></div>${hint ? `<p class="note">${esc(hint)}</p>` : ''}${rows}</div>`;
    };
    const confirmBlocks = [];
    const lowBlocks = [];
    let confirmCount = 0;
    let lowCount = 0;
    if (inboxGroups && inboxGroups.length) {
      for (const group of inboxGroups) {
        if (!group || !Array.isArray(group.items) || !group.items.length) continue;
        const confirmItems = group.items.filter(isConfirm);
        const lowItems = group.items.filter((row) => !isConfirm(row));
        if (confirmItems.length) { confirmCount += confirmItems.length; confirmBlocks.push(groupBlock(group, confirmItems)); }
        if (lowItems.length) { lowCount += lowItems.length; lowBlocks.push(groupBlock(group, lowItems)); }
      }
    } else if (inboxItems.length) {
      // 降级路径：拿不到 groups（旧主进程/读失败）逐字退回既有扁平清单。
      const inboxRows = inboxItems.map(flatInboxRow).join('');
      confirmBlocks.push(`<div class="sect-block"><div class="tt">${esc(T('cognition.inbox_section', '待确认清单'))}<span class="note">${esc(String(inboxItems.length))}</span></div>${inboxRows}</div>`);
      confirmCount += inboxItems.length;
    }
    const decideCount = confirmCount + ready.length;
    const lowTotal = lowCount + snoozed.length;
    const evidenceCount = broken.length + weak.length;
    const allQuiet = !attention.length && !confirmCount && !lowCount && !pending.length && !terminal.length && !processed.length;
    /* 导语（specs/018 T010）：一句话回答「现在要我拍板什么」。概览计数收成
     * 导语里两个可点数字（拍板数 / 证据异常数），点数字滚到对应分区——
     * 统计条与分组计数的重复就此砍掉。「预计分钟数」是硬编码经验值（2026-09-28
     * 两页重整删除）：数字看着像承诺，实际不是测量。 */
    const leadNum = (value, anchor) => `<span class="chip-link ca-jump-num" data-act="review-jump" data-id="${esc(anchor)}" aria-label="${esc(T('cognition.review_lead_jump_aria', '跳到「{where}」', { where: anchor === 'ca-review-decide' ? T('cognition.review_queue_decide', '要你拍板') : anchor === 'ca-review-evidence' ? T('cognition.review_lead_evidence', '条证据要补') : T('cognition.overview_list_title', '资产明细') }))}" ${roleBtn()}>${esc(String(value))}</span>`;
    /* 分段拼导语（迭代轮 1 修）：拍板段只在 >0 时出现，锚点也随之恒在。 */
    const decidePart = decideCount
      ? `${leadNum(decideCount, 'ca-review-decide')} ${esc(T('cognition.review_lead_decide', '件事等你拍板'))}`
      : '';
    const evidencePart = evidenceCount ? `${leadNum(evidenceCount, 'ca-review-evidence')} ${esc(T('cognition.review_lead_evidence', '条证据要补'))}` : '';
    const lowPart = lowTotal ? esc(T('cognition.review_lead_low', '{n} 条不急，先收着', { n: String(lowTotal) })) : '';
    const leadHtml = [decidePart, evidencePart, lowPart].filter(Boolean).length
      ? `<div class="sub">${[decidePart, evidencePart, lowPart].filter(Boolean).join(' · ')}</div>`
      : '';
    /* 确认后两分钟内回到本页时，提供到刚保存资产详情的明确入口。
     * 认知树保留全景导航职责，不承载单条资产详情。 */
    const promoted = S.lastPromoted && (Date.now() - Number(S.lastPromoted.at || 0) < 120000)
      ? S.lastPromoted
      : null;
    const truncate = (text, limit) => (NS.truncateText ? NS.truncateText(text, limit) : String(text || '').slice(0, limit));
    const promotedHtml = promoted ? `<div class="notice-stack ca-promoted-note"><div class="notice-row">
      <div class="notice-copy"><div class="notice-title">${esc(T('cognition.review_promoted_title', '已确认 · 已保存为正式资产'))}</div>
      ${promoted.title ? `<div class="notice-detail">${esc(truncate(promoted.title, 60))}</div>` : ''}</div>
      <span class="sp"></span>${promoted.assetId ? btn(T('cognition.review_promoted_go', '查看这条资产'), 'go-inbox-asset', { id: String(promoted.assetId), small: true, primary: true }) : ''}
    </div></div>` : '';
    const decideHtml = decideCount ? `<div id="ca-review-decide">${sectionHead(T('cognition.review_queue_decide', '要你拍板'), String(decideCount))}
      <div class="note sect-note">${esc(T('cognition.review_queue_decide_hint', '每条都卡在这里等你：动作与后果写在条上，处理一条少一条。'))}</div>
      ${confirmBlocks.join('')}
      ${ready.length ? `${sectionHead(T('cognition.review_group_wait', '等待你确认'), String(ready.length))}<div class="note sect-note">${esc(T('cognition.review_group_wait_note', '保存后生成第一版，来源与撤销入口都保留'))} · ${esc(termNote('candidate'))}</div>${ready.map((c) => candidateCard(c, false)).join('')}` : ''}</div>` : '';
    const lowHtml = lowTotal ? `<details class="details fold fold-low"><summary>${esc(T('cognition.review_queue_low', '低打扰'))}<span class="n">${lowTotal}</span></summary><div class="dbody"><div class="note">${esc(T('cognition.review_queue_low_hint', '不急，但不会自己消失：有空时逐条处理。'))}</div>${lowBlocks.join('')}</div></details>` : '';
    /* 「其他异常」组（specs/018 T013）：整理失败 / 任务执行失败 / 来源异常
     * 不再混在治理区——它们不是拍板事项，归页尾折叠；展开态跟随
     * route.sourceIssueOpen，点「处理」不会把刚展开的名单又折回去。 */
    const attentionHtml = attention.length
      ? `<details class="details fold fold-attention"${String(route.sourceIssueOpen || '') === 'open' ? ' open' : ''}><summary>${esc(T('cognition.review_other_issues', '其他异常'))}<span class="n">${attention.length}</span></summary><div class="dbody"><div class="note">${esc(T('cognition.review_other_issues_hint', '不是等你拍板的事：整理没跑成、任务没得到回复、来源读取异常；处理入口在「系统活动」。'))}</div>${attention.join('')}${sourceIssuesSection(route)}${taskFailedSection(route)}</div></details>`
      : '';
    return `${hero(T('cognition.review_title', '待我处理'), '', leadHtml)}
    ${promotedHtml}
    ${allQuiet ? `<div class="sect-block">${empty(
      T('cognition.inbox_empty', '没有需要你确认的事项。'),
      T('cognition.review_all_quiet_hint', '现在没有要你决定的，系统继续在后台沉淀；有新待办时会回到这里。'),
      { label: T('cognition.review_empty_go_activity', '去看看系统在忙什么'), attrs: { 'data-act': 'go-organize' } },
    )}</div>` : `${decideHtml}
    ${broken.length || weak.length ? `<div id="ca-review-evidence">
    ${broken.length ? `${sectionHead(T('cognition.review_group_evidence', '来源已删除的候选'), String(broken.length))}<div class="note sect-note">${esc(T('cognition.review_group_evidence_note', '这些候选的原始出处已被删除；可以点开确认后仍要保存，或选择不保存'))}</div>${broken.map((c) => candidateCard(c, true)).join('')}` : ''}
    ${weak.length ? `${sectionHead(T('cognition.review_group_weak', '证据不足（先补证据）'), String(weak.length))}<div class="note sect-note">${esc(T('cognition.review_group_weak_note', '可以修改内容并补上证据后保存，或先稍后处理'))}</div>${weak.map((c) => candidateCard(c, false)).join('')}` : ''}
    </div>` : ''}
    ${lowHtml}`}
    ${snoozed.length ? `<details class="details fold fold-snoozed"><summary>${esc(T('cognition.review_group_snoozed', '已稍后处理'))}<span class="n">${snoozed.length}</span></summary><div class="dbody"><div class="note">${esc(T('cognition.review_group_snoozed_note', '静音中，不计入待确认'))}</div>${snoozed.map((c) => candidateCard(c, false)).join('')}</div></details>` : ''}
    ${terminal.length ? `<details class="details fold fold-terminal"><summary>${esc(T('cognition.review_group_terminal', '已失效的候选'))}<span class="n">${terminal.length}</span></summary><div class="dbody"><div class="note">${esc(T('cognition.review_group_terminal_note', '已过期或被取代，仅保留记录'))}</div>${terminal.map((c) => candidateCard(c, false)).join('')}</div></details>` : ''}
    ${processed.length ? `<details class="details fold fold-processed"><summary>${esc(T('cognition.inbox_processed_badge', '处理记录'))}<span class="n">${processed.length}</span></summary><div class="dbody"><div class="note">${esc(T('cognition.inbox_processed_hint', '按处理时间倒序，只显示已处理的决定'))}</div>${processed.map((c) => `
      <div class="vrow">
        <div class="vt"><div class="v1">${esc(candidateTitle(c))}${String(c.status || '') === 'confirmed' && c.promotedAssetId ? ` <span class="chip-link" data-act="go-inbox-asset" data-id="${esc(String(c.promotedAssetId))}" ${roleBtn()}>${esc(T('cognition.review_promoted_go', '查看这条资产'))}</span>` : ''}</div>
        <div class="v2">${esc(fmtDate(c.updatedAt || c.createdAt))} · ${esc(processedLabel(c))}</div></div>
      </div>`).join('')}</div></details>` : ''}
    ${attentionHtml}`;
  }

  NS.viewReview = viewReview;
})();
