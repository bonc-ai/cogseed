// ─── Interactive Product Tour (交互式新手引导) ──────────────────────────
//
// Triggered after the 3/4-step onboarding completes and the user lands on the
// first imported conversation. Guides with real actions via a hover tooltip:
//   1. 带着这些继续 —— 指向欢迎消息的按钮，用户确认把能力带入执行
//      （可跳过；短任务在步骤 1 完成后直接结束）。
//   2. 认知资产 —— 仅当任务较长时展示：「本次任务过长，可以先了解其他核心
//      部分」，引导点开认知资产（导入会话提取的能力在这里，可手动审核落库）。
//   3.（预留）左下角注册 —— 注册入口融合后追加。
//
// Each step blocks until the user completes the required action. 悬窗/遮罩
// 框架与四步引导后的页面结构解耦：目标通过 resolveTarget 实时解析，DOM 变化
// 由 MutationObserver 重锚定。

const _tourLog = typeof createLogger === 'function'
  ? createLogger('interactive-tour')
  : { info() {}, warn() {}, error() {} };

let _tourState = null;
let _tourBackdrop = null;
let _tourTooltip = null;
let _tourObserver = null;
let _tourRepositionTimer = null;
let _tourFinishTimer = null;

// Tour step definitions（四步引导之后的真实页面引导，复用同一悬窗/遮罩框架）：
//   1. 带着这些继续 —— 指向欢迎消息里的按钮，用户确认把能力带入执行。
//      （短任务在步骤 1 完成后直接结束；长任务继续认知资产流程。）
//   2. 认知资产 —— 提示「本次任务过长」，引导点开认知资产（导入会话提取的
//      能力在这里，可手动审核落库）。
//   3. 候选认知 —— 进入候选列表，确认或拒绝一条（只有你点头的才会留下）。
//   4. 确认后认知归你 —— 已确认资产沉淀为正式资产。
//   5. 一条资产里有什么 —— 点开资产详情看版本与来源。
//   6.（预留）左下角注册 —— 注册入口融合后追加。
const TOUR_STEPS = [
  {
    id: 'welcome-continue',
    title: '带着这些继续',
    description: '点击欢迎消息里的「带着这些继续」，把工作空间里匹配好的能力带入任务，开始真正执行。',
    resolveTarget: () => document.querySelector('.welcome-carry .welcome-carry-continue'),
    position: 'right',
    // commander 三段式回复由 LLM 生成，按钮要等回复渲染后才出现：给足等待
    // 窗口（60 × 500ms = 30s），而不是默认的 3.6s 后跳过。
    maxRetries: 60,
    retryDelay: 500,
    // 关键动作：必须实际点击按钮才继续（只提供「跳过引导」，不提供「下一步」，
    // 否则跳过后 taskIsLong 未设置 → 后续直接结束）。
    requireAction: true,
    checkComplete: () => {
      if (_tourState && _tourState.welcomeContinued) return true;
      // 用户已在 tour 启动前点击过按钮（按钮 disabled）→ 视为已完成。
      const btn = document.querySelector('.welcome-carry .welcome-carry-continue');
      return !!(btn && btn.disabled === true);
    },
  },
  {
    id: 'recall',
    title: '了解其他核心部分',
    description: '本次任务较长，可以先了解其他核心模块——点「认知资产」：你导入会话提取出来的能力都在这里展示，可以手动审核后落库。',
    target: '#recall-btn',
    position: 'right',
    // 必须实际点开认知资产才继续（后续步骤都在面板内；跳过则结束引导）。
    requireAction: true,
    checkComplete: () => !!(_tourState && _tourState.recallOpened),
  },
  {
    // Recall opens on the overview page, while candidate actions live under
    // capture tasks. Anchor to a real formal-candidate action after the user
    // navigates, and fall back to the captures nav tab (常驻) — the tab stays
    // visible even when there are no candidates yet, so the step can always
    // point somewhere actionable. 若认知资产面板尚未打开，先回退到入口按钮。
    id: 'recall-review',
    title: '候选认知，你说了算',
    description: '候选只是建议，不是结论。进入「沉淀任务」，确认或拒绝任意一条——只有你点头的才会留下。',
    resolveTarget: () => {
      const panel = document.getElementById('panel-recall');
      const visible = !!panel && panel.offsetParent !== null;
      if (!visible) return document.getElementById('recall-btn');
      return (
        document.querySelector('#panel-recall [data-recall-candidate-action="promote"], #panel-recall [data-recall-candidate-action="save-and-promote"], #panel-recall [data-recall-candidate-action="reject"], #panel-recall [data-recall-candidate-action="ignore"], #panel-recall [data-recall-candidate-action="keep-current"], #panel-recall [data-recall-candidate-promote-all]')
        || document.querySelector('#panel-recall .skills-cognition-tab[data-cognition-page="captures"]')
        || document.querySelector('#panel-recall [data-cognition-page-link="captures"]')
      );
    },
    position: 'bottom',
    checkComplete: () => !!(_tourState && (_tourState.recallReviewed || _tourState.capturesTabClicked)),
  },
  {
    id: 'recall-assets',
    title: '确认后，认知归你',
    description: '你确认的认知会沉淀为正式能力资产。点开「能力资产」这页，看看攒下了什么。',
    resolveTarget: () => {
      const panel = document.getElementById('panel-recall');
      const visible = !!panel && panel.offsetParent !== null;
      if (!visible) return document.getElementById('recall-btn');
      return (
        document.querySelector('#panel-recall .skills-cognition-tab[data-cognition-page="assets"]')
        || document.querySelector('#panel-recall [data-cognition-page-link="assets"]')
      );
    },
    position: 'bottom',
    checkComplete: () => {
      if (!_tourState) return false;
      if (_tourState.assetsOpened) return true;
      return !!document.querySelector('#panel-recall .skills-cognition-tab[data-cognition-page="assets"].is-active');
    },
  },
  {
    id: 'recall-asset-detail',
    title: '一条资产里有什么',
    description: '点开任意一条：能看到它的版本、来源，以及下次任务时会怎样用上它。',
    resolveTarget: () => {
      const panel = document.getElementById('panel-recall');
      const visible = !!panel && panel.offsetParent !== null;
      if (!visible) return document.getElementById('recall-btn');
      return (
        document.querySelector('#panel-recall [data-ability-asset-id]:not(.is-selected)')
        || document.querySelector('#panel-recall [data-ability-asset-id]')
      );
    },
    position: 'right',
    checkComplete: () => !!(_tourState && _tourState.assetDetailViewed),
  },
  // 第六步「左下角注册」预留：注册入口融合后追加
  // { id: 'signup', title: '注册 CogSeed', description: '…', resolveTarget: () => …, position: 'top', checkComplete: … },
];

function _tourEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Start the interactive tour
async function startTour() {
  if (_tourState) {
    _tourLog.warn('tour already running');
    return;
  }

  // 每账户只强制弹出一次：本账户已完成（或跳过）过引导则不再弹。
  // 读取失败（如旧版本主进程无此通道）视为未完成，照常弹出，不阻塞引导。
  try {
    if (typeof window.cogseed !== 'undefined' && typeof window.cogseed.invoke === 'function') {
      const res = await window.cogseed.invoke('prefs.getTourCompleted');
      if (res && res.completed) {
        _tourLog.info('interactive tour already completed for this account, skipping');
        return;
      }
    }
  } catch (err) {
    _tourLog.warn('tour completion gate read failed, showing tour anyway', {
      error: (err && err.message) || String(err),
    });
  }

  _tourLog.info('starting interactive tour');
  _tourState = {
    currentStep: 0,
    welcomeContinued: false,
    taskIsLong: false,
    recallOpened: false,
    recallReviewed: false,
    capturesTabClicked: false,
    assetsOpened: false,
    assetDetailViewed: false,
    completed: false,
  };

  // Create backdrop and tooltip
  _tourBackdrop = document.createElement('div');
  _tourBackdrop.className = 'tour-backdrop';
  document.body.appendChild(_tourBackdrop);

  _tourTooltip = document.createElement('div');
  _tourTooltip.className = 'tour-tooltip';
  document.body.appendChild(_tourTooltip);

  // Set up event listeners for user actions
  _setupTourListeners();
  _startTourReanchor();

  // Show first step
  _showTourStep(0);
}

// The sidebar re-renders as the user expands a project or a conversation
// arrives, which replaces the node the tooltip was anchored to. Re-resolve and
// re-place instead of leaving the card pointing at a stale rect.
function _startTourReanchor() {
  const reposition = () => {
    if (_tourRepositionTimer) clearTimeout(_tourRepositionTimer);
    _tourRepositionTimer = setTimeout(() => {
      _tourRepositionTimer = null;
      if (!_tourState || _tourState.completed || !_tourTooltip) return;
      const step = TOUR_STEPS[_tourState.currentStep];
      if (!step) return;
      const el = _resolveStepTarget(step);
      if (!el) return;
      if (el !== _tourState.targetEl) {
        _tourState.targetEl = el;
        _highlightTarget(el);
      }
      _positionTooltip(step.position || 'right', el.getBoundingClientRect());
    }, 120);
  };

  // Watches the whole document, not just the sidebar: the recall-review step
  // anchors inside the Recall panel, which re-renders on its own. The 120ms
  // debounce above keeps the extra callbacks cheap, and the tour is short-lived.
  _tourObserver = new MutationObserver(reposition);
  _tourObserver.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', reposition);
  _tourState.onReposition = reposition;
}

function _setupTourListeners() {
  // Listen for view changes: 认知资产（recall）步骤的完成检测。
  const originalSetView = window.setView;
  if (typeof originalSetView === 'function') {
    _tourState.originalSetView = originalSetView;
    window.setView = function(view, ...args) {
      const result = originalSetView.apply(this, [view, ...args]);
      if (_tourState && !_tourState.completed) {
        if (view === 'recall') {
          _tourState.recallOpened = true;
          _checkStepComplete();
        }
      }
      return result;
    };
  }

  // 认知资产面板内的交互（候选审核 / 资产页 / 资产详情）：capture 阶段监听，
  // 因为 recall 模块自己的委托处理器会重渲染并替换被点击节点——先读意图保持
  // 独立于渲染时机。
  _tourState.onTourClick = (event) => {
    if (!_tourState || _tourState.completed) return;
    const node = event.target;
    if (!node || typeof node.closest !== 'function') return;
    if (node.closest('#panel-recall [data-recall-candidate-action="promote"], #panel-recall [data-recall-candidate-action="save-and-promote"], #panel-recall [data-recall-candidate-action="reject"], #panel-recall [data-recall-candidate-action="ignore"], #panel-recall [data-recall-candidate-action="keep-current"], #panel-recall [data-recall-candidate-promote-all]')) {
      _tourState.recallReviewed = true;
      _checkStepComplete();
      return;
    }
    // 沉淀任务 tab（常驻导航）：无候选时点 tab 也算展示了"审核候选"的位置。
    if (node.closest('#panel-recall .skills-cognition-tab[data-cognition-page="captures"], #panel-recall [data-cognition-page-link="captures"]')) {
      _tourState.capturesTabClicked = true;
      _checkStepComplete();
      return;
    }
    if (node.closest('#panel-recall .skills-cognition-tab[data-cognition-page="assets"], #panel-recall [data-cognition-page-link="assets"]')) {
      _tourState.assetsOpened = true;
      _checkStepComplete();
      return;
    }
    if (node.closest('#panel-recall [data-ability-asset-id]')) {
      _tourState.assetDetailViewed = true;
      _checkStepComplete();
    }
  };
  document.addEventListener('click', _tourState.onTourClick, true);
}

function _checkStepComplete() {
  if (!_tourState || _tourState.completed) return;

  // This runs from several call sites (the setView hook, click handlers, the
  // poll). Without a latch, a step that stays complete queues one advance timer
  // per call and the extra timers skip past the following steps.
  if (_tourState.advancing) return;

  const step = TOUR_STEPS[_tourState.currentStep];
  if (step && step.checkComplete()) {
    _tourLog.info('step completed', { step: step.id });

    // Move to next step after a short delay
    _tourState.advancing = true;
    _tourState.advanceTimer = setTimeout(() => {
      if (!_tourState || _tourState.completed) return;
      _tourState.advanceTimer = null;
      _tourState.advancing = false;
      _advanceStep();
    }, 800);
  }
}

function _advanceStep() {
  if (!_tourState || _tourState.completed) return;
  // A manual "next" click can race the auto-advance timer; whoever runs first
  // owns the transition.
  if (_tourState.advanceTimer) {
    clearTimeout(_tourState.advanceTimer);
    _tourState.advanceTimer = null;
  }
  _tourState.advancing = false;
  const current = TOUR_STEPS[_tourState.currentStep];
  // 步骤 1（带着这些继续）完成后：任务不长 → 直接结束，不展示
  // 「本次任务过长 → 认知资产」的步骤。
  if (current && current.id === 'welcome-continue' && !_tourState.taskIsLong) {
    _tourLog.info('short task — completing tour after welcome step', { taskIsLong: _tourState.taskIsLong });
    _completeTour();
    return;
  }
  if (_tourState.currentStep < TOUR_STEPS.length - 1) {
    _tourState.currentStep++;
    _tourState.targetRetries = 0;
    _tourLog.info('tour advance', { from: current && current.id, to: TOUR_STEPS[_tourState.currentStep].id });
    _showTourStep(_tourState.currentStep);
  } else {
    _tourLog.info('tour reached last step, completing', { step: current && current.id });
    _completeTour();
  }
}

function _resolveStepTarget(step) {
  if (typeof step.resolveTarget === 'function') {
    try {
      const el = step.resolveTarget();
      if (el) return el;
    } catch (err) {
      _tourLog.warn('tour resolveTarget threw', {
        step: step.id, error: (err && err.message) || String(err),
      });
    }
  }
  return step.target ? document.querySelector(step.target) : null;
}

function _showTourStep(stepIndex) {
  const step = TOUR_STEPS[stepIndex];
  if (!step) return;

  _tourLog.info('showing tour step', { step: step.id, index: stepIndex });

  // Find target element. The sidebar tree can still be rendering when the tour
  // starts right after onboarding, so a miss is retried before giving up —
  // skipping immediately used to silently drop the step. Steps that depend on
  // slow async content (e.g. the welcome reply generated by an LLM) declare a
  // longer window via step.maxRetries / step.retryDelay.
  const targetEl = _resolveStepTarget(step);
  if (!targetEl) {
    const maxRetries = Number.isFinite(step.maxRetries) ? step.maxRetries : 12;
    const retryDelay = Number.isFinite(step.retryDelay) ? step.retryDelay : 300;
    _tourState.targetRetries = (_tourState.targetRetries || 0) + 1;
    if (_tourState.targetRetries <= maxRetries) {
      _tourLog.warn('tour target not ready, retrying', {
        step: step.id, attempt: _tourState.targetRetries,
      });
      setTimeout(() => {
        if (_tourState && !_tourState.completed && _tourState.currentStep === stepIndex) {
          _showTourStep(stepIndex);
        }
      }, retryDelay);
      return;
    }
    _tourLog.warn('tour target not found, skipping step', { step: step.id });
    _tourState.targetRetries = 0;
    if (stepIndex < TOUR_STEPS.length - 1) {
      _tourState.currentStep++;
      _showTourStep(_tourState.currentStep);
    } else {
      _completeTour();
    }
    return;
  }
  _tourState.targetRetries = 0;

  if (typeof targetEl.scrollIntoView === 'function') {
    targetEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // Position tooltip near target
  const rect = targetEl.getBoundingClientRect();
  // requireAction 步骤（关键动作）只提供「跳过引导」，隐藏「下一步」——必须
  // 实际完成高亮处的操作才能继续，避免连点跳过导致引导断裂/提前结束。
  const nextBtnHtml = step.requireAction
    ? ''
    : `<button type="button" class="tour-tooltip-btn primary" data-tour-action="next">${stepIndex < TOUR_STEPS.length - 1 ? '知道了' : '完成'}</button>`;
  const tooltipHTML = `
    <div class="tour-tooltip-content">
      <div class="tour-tooltip-title">${_tourEsc(step.title)}</div>
      <div class="tour-tooltip-desc">${_tourEsc(step.description)}</div>
      <div class="tour-tooltip-actions">
        <button type="button" class="tour-tooltip-link" data-tour-action="skip">跳过</button>
        ${nextBtnHtml}
      </div>
    </div>
    <div class="tour-tooltip-arrow"></div>
  `;

  _tourTooltip.innerHTML = tooltipHTML;
  _tourTooltip.querySelectorAll('[data-tour-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tourAction === 'skip') {
        _tourLog.info('tour skipped by user', { step: step.id });
        _completeTour({ skipped: true });
      } else {
        _advanceStep();
      }
    });
  });
  _tourTooltip.classList.remove('left', 'right', 'top', 'bottom');
  _tourTooltip.classList.add(step.position || 'right');

  // Show before measuring: offsetWidth/offsetHeight read 0 while `display:none`,
  // which placed the `left` and `top` variants at the wrong coordinates.
  _tourTooltip.style.display = 'block';
  _positionTooltip(step.position || 'right', rect);

  _tourState.targetEl = targetEl;
  _highlightTarget(targetEl);
}

function _positionTooltip(position, rect) {
  const w = _tourTooltip.offsetWidth;
  const h = _tourTooltip.offsetHeight;
  const margin = 12;
  let left;
  let top;
  if (position === 'left') {
    left = rect.left - w - 20;
    top = rect.top + rect.height / 2 - h / 2;
  } else if (position === 'bottom') {
    left = rect.left + rect.width / 2 - w / 2;
    top = rect.bottom + 20;
  } else if (position === 'top') {
    left = rect.left + rect.width / 2 - w / 2;
    top = rect.top - h - 20;
  } else {
    left = rect.right + 20;
    top = rect.top + rect.height / 2 - h / 2;
  }
  // Clamp into the window: a target near the sidebar bottom pushed the card
  // off-screen, which is part of why it looked like it pointed at nothing.
  left = Math.min(Math.max(left, margin), Math.max(margin, window.innerWidth - w - margin));
  top = Math.min(Math.max(top, margin), Math.max(margin, window.innerHeight - h - margin));
  // Centering is computed here, so drop the old translate-based offset.
  _tourTooltip.style.transform = 'none';
  _tourTooltip.style.left = `${Math.round(left)}px`;
  _tourTooltip.style.top = `${Math.round(top)}px`;
}

function _highlightTarget(el) {
  // Remove previous highlight
  document.querySelectorAll('.tour-highlight').forEach(h => h.classList.remove('tour-highlight'));

  // Add highlight to target
  el.classList.add('tour-highlight');
}

function _completeTour(opts) {
  const skipped = !!(opts && opts.skipped);
  _tourLog.info(skipped ? 'interactive tour skipped' : 'interactive tour completed');

  // 每账户只强制弹出一次：完成或跳过都视为「已看过」，立即落盘（fire-and-forget，
  // 失败仅记日志，下次启动会再次尝试，不阻塞当前 UI）。落盘必须放在任何提前
  // return 之前，保证跳过/完成两个路径都写入。
  if (typeof window.cogseed !== 'undefined' && typeof window.cogseed.invoke === 'function') {
    window.cogseed.invoke('prefs.setTourCompleted').catch((err) => {
      _tourLog.warn('failed to persist tour completion', {
        error: (err && err.message) || String(err),
      });
    });
  }

  // Everything that could advance a step or move the card is stopped here,
  // before the finish card goes up, so nothing repositions behind it.
  if (_tourState) {
    _tourState.completed = true;
    if (_tourState.advanceTimer) {
      clearTimeout(_tourState.advanceTimer);
      _tourState.advanceTimer = null;
    }
    _tourState.advancing = false;
    if (_tourState.onReposition) {
      window.removeEventListener('resize', _tourState.onReposition);
      _tourState.onReposition = null;
    }
    if (_tourState.onTourClick) {
      document.removeEventListener('click', _tourState.onTourClick, true);
      _tourState.onTourClick = null;
    }
    // Restore the patched view hook so a second run doesn't stack wrappers.
    if (typeof _tourState.originalSetView === 'function') {
      window.setView = _tourState.originalSetView;
      _tourState.originalSetView = null;
    }
  }
  if (_tourObserver) {
    _tourObserver.disconnect();
    _tourObserver = null;
  }
  if (_tourRepositionTimer) {
    clearTimeout(_tourRepositionTimer);
    _tourRepositionTimer = null;
  }

  document.querySelectorAll('.tour-highlight').forEach(h => h.classList.remove('tour-highlight'));

  if (skipped || !_tourTooltip) {
    _teardownTour();
    return;
  }
  _showTourFinishCard();
}

// Passing the last step used to make the whole tour vanish with no closing
// beat, which reads as the UI glitching rather than as finishing.
function _showTourFinishCard() {
  _tourTooltip.classList.remove('left', 'right', 'top', 'bottom');
  _tourTooltip.classList.add('tour-tooltip-finish');
  _tourTooltip.innerHTML = `
    <div class="tour-tooltip-content">
      <div class="tour-tooltip-title">引导完成</div>
      <p class="tour-tooltip-desc">你已把工作空间的能力带入任务开始执行。认知资产里沉淀的能力会随任务自动跟上。</p>
      <div class="tour-tooltip-actions">
        <button type="button" class="tour-tooltip-btn primary" data-tour-action="done">知道了</button>
      </div>
    </div>
  `;
  const doneBtn = _tourTooltip.querySelector('[data-tour-action="done"]');
  if (doneBtn) doneBtn.addEventListener('click', () => _teardownTour());

  // Centered: there is no target left to point at.
  _tourTooltip.style.display = 'block';
  _tourTooltip.style.left = `${Math.round((window.innerWidth - _tourTooltip.offsetWidth) / 2)}px`;
  _tourTooltip.style.top = `${Math.round((window.innerHeight - _tourTooltip.offsetHeight) / 2)}px`;

  // Never strand the backdrop if the user walks away without dismissing.
  _tourFinishTimer = setTimeout(_teardownTour, 12000);
}

function _teardownTour() {
  if (_tourFinishTimer) {
    clearTimeout(_tourFinishTimer);
    _tourFinishTimer = null;
  }
  if (_tourBackdrop && _tourBackdrop.parentNode) {
    _tourBackdrop.remove();
  }
  if (_tourTooltip && _tourTooltip.parentNode) {
    _tourTooltip.remove();
  }

  document.querySelectorAll('.tour-highlight').forEach(h => h.classList.remove('tour-highlight'));

  _tourBackdrop = null;
  _tourTooltip = null;
  _tourState = null;
}

// Expose for external triggers
window.interactiveTour = {
  start: startTour,
  // 用户点击了欢迎消息里的「带着这些继续」：opts.taskIsLong 表示本次任务是否
  // 较长（决定是否继续展示「认知资产」步骤）。
  markWelcomeContinued: (opts) => {
    if (_tourState && !_tourState.completed) {
      _tourState.welcomeContinued = true;
      _tourState.taskIsLong = !!(opts && opts.taskIsLong);
      _checkStepComplete();
    }
  },
};
