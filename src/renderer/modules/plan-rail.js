'use strict';

// plan-rail.js — 会话区中间「执行计划」轨道（CogSeed 9.1 统一框架 §9.1 中间区）。
//
// 背景：`#plan-rail` 的 DOM 壳与样式契约（style.css `.plan-rail*`）早已就位，
// 本文件之前只是 no-op 桥。现在接上真实数据：
//
// 数据来源（复用既有事件，不新增 IPC）：
//   1. 实时：conversation.js 在收到 `stream === 'plan'` 事件时调用
//      `window.planRail.onPlanEvent(cid, evt)`。事件 data 形状
//      `{ steps?: [{ title|description, status?, meta?, reason? }], phase? }`
//      （core-agent `plan_set` 工具执行事件；与 conversation.js
//      `_formatEventLine` 的 plan 分支同一契约）。
//   2. 历史恢复：渲染历史消息的 process 事件时，conversation.js 把其中
//      `stream === 'plan'` 的事件通过 `window.planRail.restorePlanEvent(evt)`
//      逐个喂入（会话打开时 `setCid(cid)` 已先复位）。
//
// 渲染契约（style.css 已定义，本文件只填充）：
//   - 无 plan → `#plan-rail` display:none（`.chat-plan-strip` 随之隐藏）。
//   - 有 plan → head：label + progress（`已完成/总数`）+ 分段进度条
//     （每步一格，is-done / is-active / is-failed / is-blocked）。
//   - `#plan-rail-body`（历史注释保留给下游复用）承载步骤列表，复用既有
//     `.plan-rail-step` 两行布局契约：head（icon + num + title）+ 可选
//     meta / reason。步骤状态类：is-pending / is-in_progress / is-done /
//     is-failed / is-skipped / is-blocked。
//
// 不改变既有交互：消息流内的 plan-announce 标签、`#plan-rail-expand`
// （打开会话详情）都保持原样。

(function attachPlanRail() {
  if (typeof window === 'undefined') return;

  const _plans = new Map(); // cid → { steps: [{title, status, meta, reason}], phase, updatedAt }
  let _currentCid = '';

  function _el(id) { return document.getElementById(id); }

  // 事件状态字符串 → 步骤类名（style.css 既有契约）。
  function _stepClass(status, index, phase, total) {
    const s = String(status || '').toLowerCase();
    if (s === 'done' || s === 'completed' || s === 'success' || s === 'ok') return 'is-done';
    if (s === 'active' || s === 'running' || s === 'in_progress' || s === 'working') return 'is-in_progress';
    if (s === 'failed' || s === 'error' || s === 'rejected') return 'is-failed';
    if (s === 'skipped' || s === 'skip') return 'is-skipped';
    if (s === 'blocked' || s === 'waiting' || s === 'pending') return 'is-blocked';
    // 无显式状态：按整体阶段推断。completed → 全部完成；running/active →
    // 最后一步进行中、其余完成；其余 → 全部待处理。
    const ph = String(phase || '').toLowerCase();
    if (ph === 'completed' || ph === 'done' || ph === 'success') return 'is-done';
    if (ph === 'running' || ph === 'active' || ph === 'in_progress' || ph === 'working') {
      return index === total - 1 ? 'is-in_progress' : 'is-done';
    }
    return 'is-pending';
  }

  // 步骤类名 → 进度条 cell 类名（style.css 分段条契约）。
  function _barCellClass(stepClass) {
    if (stepClass === 'is-done') return 'is-done';
    if (stepClass === 'is-in_progress') return 'is-active';
    if (stepClass === 'is-failed') return 'is-failed';
    if (stepClass === 'is-blocked') return 'is-blocked';
    return '';
  }

  // 步骤类名 → 状态图标（icons.js 集中图标，禁止 emoji / 硬编码 SVG）。
  function _stepIconName(stepClass) {
    if (stepClass === 'is-done') return 'check-circle';
    if (stepClass === 'is-in_progress') return 'play-triangle';
    if (stepClass === 'is-failed') return 'x-circle';
    if (stepClass === 'is-skipped') return 'skip-forward';
    if (stepClass === 'is-blocked') return 'shield-check';
    return 'list-ordered';
  }

  function _counts(steps, phase) {
    let done = 0;
    let active = 0;
    let failed = 0;
    let blocked = 0;
    steps.forEach((step, index) => {
      const cls = _stepClass(step && step.status, index, phase, steps.length);
      if (cls === 'is-done') done += 1;
      else if (cls === 'is-in_progress') active += 1;
      else if (cls === 'is-failed') failed += 1;
      else if (cls === 'is-blocked') blocked += 1;
    });
    return { done, active, failed, blocked };
  }

  function _stepTitle(step, index) {
    if (step && typeof step === 'object') {
      const t = String(step.title || step.description || step.name || '').trim();
      if (t) return t;
    }
    return String(step || '').trim() || `Step ${index + 1}`;
  }

  function _stepText(step, key) {
    if (!step || typeof step !== 'object') return '';
    return String(step[key] || '').trim();
  }

  function _uiIcon(name, className) {
    if (typeof window.uiIconHtml === 'function') {
      return window.uiIconHtml(name, className || 'plan-rail-svg-icon');
    }
    return '';
  }

  // 合并一次 plan 事件到指定会话的状态。
  function _applyEvent(cid, evt) {
    if (!cid || !evt || typeof evt !== 'object') return false;
    const data = evt.data && typeof evt.data === 'object' ? evt.data : {};
    const current = _plans.get(cid) || { steps: [], phase: '', updatedAt: 0 };
    let changed = false;

    if (Array.isArray(data.steps) && data.steps.length) {
      // 重建步骤列表：保留既有步骤的状态（按 index），新步骤并入。
      const next = data.steps.map((step, index) => {
        const prev = current.steps[index];
        const status = (step && typeof step === 'object' && step.status)
          ? String(step.status)
          : (prev ? prev.status : '');
        return {
          title: _stepTitle(step, index),
          status,
          meta: _stepText(step, 'meta') || (prev ? prev.meta : ''),
          reason: _stepText(step, 'reason') || (prev ? prev.reason : ''),
        };
      });
      current.steps = next;
      changed = true;
    }

    if (data.phase !== undefined) {
      current.phase = String(data.phase || '');
      changed = true;
    }

    // 单步状态更新形态（`{ step_index, status }` 或 `{ index, status }`）。
    const stepIndex = Number(data.step_index !== undefined ? data.step_index : data.index);
    if (Number.isFinite(stepIndex) && data.status && Array.isArray(current.steps)
        && current.steps[stepIndex]) {
      current.steps[stepIndex].status = String(data.status);
      changed = true;
    }

    if (!changed) return false;
    current.updatedAt = Date.now();
    _plans.set(cid, current);
    return true;
  }

  function _render() {
    const rail = _el('plan-rail');
    if (!rail) return;
    const plan = _currentCid ? _plans.get(_currentCid) : null;
    if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) {
      rail.style.display = 'none';
      return;
    }
    rail.style.display = '';

    const steps = plan.steps;
    const counts = _counts(steps, plan.phase);
    const total = steps.length;
    const done = counts.done;

    const progressEl = _el('plan-rail-progress');
    if (progressEl) progressEl.textContent = `${done}/${total}`;

    const bar = _el('plan-rail-bar');
    if (bar) {
      bar.innerHTML = steps.map((step, index) => {
        const stepClass = _stepClass(step && step.status, index, plan.phase, total);
        const cellClass = _barCellClass(stepClass);
        const title = _stepTitle(step, index);
        return `<div class="plan-rail-bar-cell${cellClass ? ' ' + cellClass : ''}" title="${_escapeAttr(title)}"></div>`;
      }).join('');
    }

    const body = _el('plan-rail-body');
    if (body) {
      body.hidden = false;
      body.innerHTML = `<div class="plan-rail-steps">${steps.map((step, index) => {
        const stepClass = _stepClass(step && step.status, index, plan.phase, total);
        const title = _stepTitle(step, index);
        const meta = _stepText(step, 'meta');
        const reason = _stepText(step, 'reason');
        return `<div class="plan-rail-step ${stepClass}">`
          + `<div class="plan-rail-step-head">`
          + `<span class="plan-rail-step-icon">${_uiIcon(_stepIconName(stepClass))}</span>`
          + `<span class="plan-rail-step-num">${index + 1}</span>`
          + `<span class="plan-rail-step-title">${_escapeHtml(title)}</span>`
          + `</div>`
          + (meta ? `<div class="plan-rail-step-meta">${_escapeHtml(meta)}</div>` : '')
          + (reason ? `<div class="plan-rail-step-reason">${_escapeHtml(reason)}</div>` : '')
          + `</div>`;
      }).join('')}</div>`;
      // 图标占位统一由 icons.js 的水合机制填充。
      if (typeof window.hydrateUiIcons === 'function') window.hydrateUiIcons(body);
    }
  }

  function _escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _escapeAttr(value) {
    return _escapeHtml(value);
  }

  const api = {
    // 会话切换 / 历史加载入口：复位当前会话，无 plan 时隐藏轨道。
    setCid(cid) {
      _currentCid = String(cid || '');
      _render();
    },
    // 实时 plan 事件（conversation.js 事件分发处调用）。
    onPlanEvent(cid, evt) {
      const target = String(cid || _currentCid || '');
      if (!target) return;
      _currentCid = target;
      if (_applyEvent(target, evt)) _render();
    },
    // 历史恢复：渲染历史消息的 process 时逐个喂入 plan 事件（作用于当前会话）。
    restorePlanEvent(evt) {
      if (!_currentCid) return;
      if (_applyEvent(_currentCid, evt)) _render();
    },
    // 测试 / 调试用：读当前会话的 plan 摘要。
    currentPlan() {
      const plan = _currentCid ? _plans.get(_currentCid) : null;
      if (!plan) return null;
      return {
        cid: _currentCid,
        phase: plan.phase,
        steps: (plan.steps || []).map((s) => ({
          title: s.title, status: s.status || '', meta: s.meta || '', reason: s.reason || '',
        })),
        updatedAt: plan.updatedAt,
      };
    },
    // 9.1 统一框架 · 左侧「任务与Session」：按会话读计划进度（无计划返回 null）。
    planFor(cid) {
      if (!cid) return null;
      const plan = _plans.get(String(cid));
      if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) return null;
      const counts = _counts(plan.steps, plan.phase);
      return {
        cid: String(cid),
        phase: plan.phase,
        total: plan.steps.length,
        done: counts.done,
        active: counts.active,
        failed: counts.failed,
        blocked: counts.blocked,
        updatedAt: plan.updatedAt,
      };
    },
  };

  if (!window.planRail) window.planRail = api;
  else Object.assign(window.planRail, api);
})();
