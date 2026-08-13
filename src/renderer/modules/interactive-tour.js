// ─── Interactive Product Tour (交互式新手引导) ──────────────────────────
//
// Triggered after the 4-step onboarding completes. Guides users through
// the main modules with interactive prompts that require real actions:
//   1. Open an imported conversation
//   2. View Agents (AI Team)
//   3. View Skills
//   4. Open Recall
//   5. Reach the candidate list and decide one cognition
//   6. Open the ability-assets page
//   7. Inspect one asset's detail
//
// Steps 4 and 5 are split because Recall opens on its overview page while
// candidates live under deposition/candidates — one step asking for both left
// the navigation hop unmentioned and unreachable.
//
// Steps 6 and 7 continue inside Recall on purpose: deciding a candidate only
// shows the intake side of the loop, so the tour then walks to where confirmed
// cognition actually lands and what a single asset record looks like.
//
// Each step blocks until the user completes the required action. For now,
// triggers on every launch; later will be gated to once per account.

const _tourLog = typeof createLogger === 'function'
  ? createLogger('interactive-tour')
  : { info() {}, warn() {}, error() {} };

let _tourState = null;
let _tourBackdrop = null;
let _tourTooltip = null;
let _tourObserver = null;
let _tourRepositionTimer = null;
let _tourFinishTimer = null;

// Project name onboarding uses when it groups imported conversations.
// Keep in sync with the `projects.create` call in onboarding's role setup.
const IMPORTED_PROJECT_NAME = '导入的会话';

function _findProjectRowByName(name) {
  const rows = document.querySelectorAll('#projects-list .project-row[data-pid]');
  for (const row of rows) {
    const label = row.querySelector('.project-name');
    if (label && label.textContent.trim() === name) return row;
  }
  return null;
}

// Tour step definitions
const TOUR_STEPS = [
  {
    id: 'conversation',
    title: '你的历史会话',
    description: '你过去的对话都在这里，随时能接着聊。点开一条看看。',
    // Onboarding moves imported conversations into a project, which leaves the
    // ungrouped `#conversation-list` empty — so anchoring there highlighted a
    // blank box. Resolve the real row instead, preferring the deepest thing
    // the user can actually click.
    resolveTarget: () => (
      document.querySelector('#projects-list .project-conv-list .conv-item[data-cid]')
      || _findProjectRowByName(IMPORTED_PROJECT_NAME)
      || document.querySelector('#conversation-list .conv-item[data-cid]')
      || document.querySelector('#projects-list .project-row[data-pid]')
    ),
    position: 'right',
    checkComplete: () => {
      // User opened a conversation (view changed to 'conversation')
      return _tourState && _tourState.conversationOpened;
    },
  },
  {
    id: 'agents',
    title: '查看 AI 团队',
    description: '这些是你接入的模型和本机 Agent，任务由它们执行。点左侧「AI 团队」看看都有谁。',
    target: '#agents-btn',
    position: 'right',
    checkComplete: () => {
      return _tourState && _tourState.agentsViewed;
    },
  },
  {
    id: 'skills',
    title: '查看技能库',
    description: '这里放着你能调用的技能，干活时按需取用。点左侧「技能库」看看。',
    target: '#skills-btn',
    position: 'right',
    checkComplete: () => {
      return _tourState && _tourState.skillsViewed;
    },
  },
  {
    id: 'recall',
    title: '你的认知资产',
    description: 'CogSeed 从你的会话里发现了值得留下的认知。点「认知资产」，看它们放在了哪。',
    target: '#recall-btn',
    position: 'right',
    checkComplete: () => {
      return _tourState && _tourState.recallOpened;
    },
  },
  {
    // Recall opens on the `overview` page, but candidate cards live under
    // deposition/candidates — so "click Recall then review a candidate" had an
    // unmentioned navigation hop in the middle and could never complete.
    // Overview already renders a link to the candidate list whenever candidates
    // are pending, so anchor to that instead of inventing a new entry point.
    id: 'recall-review',
    title: '候选认知，你说了算',
    description: '候选只是建议，不是结论。进入候选列表，确认或拒绝任意一条——只有你点头的才会留下。',
    resolveTarget: () => (
      // Once the user has navigated, the overview link is gone and the decision
      // buttons are on screen — follow them so the card stops pointing at a
      // stale rect.
      document.querySelector('#panel-recall [data-cognition-candidate-action]')
      || document.querySelector('#panel-recall [data-cognition-page-link="deposition"][data-cognition-deposition-target="candidates"]')
    ),
    position: 'bottom',
    checkComplete: () => {
      return _tourState && _tourState.recallReviewed;
    },
  },
  {
    id: 'recall-assets',
    title: '确认后，认知归你',
    description: '你刚确认的认知，已经沉淀为正式资产。点开这页，看看攒下了什么。',
    // The Recall nav tab is the stable entry point; the overview page also
    // renders a link to the same place, so fall back to it when the user is
    // still on overview and the tab is off-screen.
    resolveTarget: () => (
      document.querySelector('#panel-recall .skills-cognition-tab[data-cognition-page="assets"]')
      || document.querySelector('#panel-recall [data-cognition-page-link="assets"]')
    ),
    position: 'bottom',
    checkComplete: () => {
      if (!_tourState) return false;
      // The assets page starts hidden and only the user's click can reveal it,
      // so its visibility is a real completion signal on its own — the click
      // flag just makes the step respond without waiting for a re-render.
      if (_tourState.assetsOpened) return true;
      return !!document.querySelector('#panel-recall [data-cognition-page-body="assets"]:not([hidden])');
    },
  },
  {
    id: 'recall-asset-detail',
    title: '一条资产里有什么',
    description: '点开任意一条：能看到它的版本、来源，以及下次任务时会怎样用上它。',
    // Prefer a row the user hasn't got open: the assets page auto-selects the
    // first record, so pointing at that one asks for a click that changes
    // nothing on screen.
    resolveTarget: () => (
      document.querySelector('#panel-recall [data-ability-asset-id]:not(.is-selected)')
      || document.querySelector('#panel-recall [data-ability-asset-id]')
    ),
    position: 'right',
    checkComplete: () => {
      return _tourState && _tourState.assetDetailViewed;
    },
  },
];

function _tourEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Start the interactive tour
function startTour() {
  if (_tourState) {
    _tourLog.warn('tour already running');
    return;
  }

  _tourLog.info('starting interactive tour');
  _tourState = {
    currentStep: 0,
    conversationOpened: false,
    agentsViewed: false,
    skillsViewed: false,
    recallOpened: false,
    recallReviewed: false,
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
  // Listen for view changes
  const originalSetView = window.setView;
  if (typeof originalSetView === 'function') {
    _tourState.originalSetView = originalSetView;
    window.setView = function(view, ...args) {
      const result = originalSetView.apply(this, [view, ...args]);
      if (_tourState && !_tourState.completed) {
        if (view === 'conversation') {
          _tourState.conversationOpened = true;
          _checkStepComplete();
        } else if (view === 'agents') {
          _tourState.agentsViewed = true;
          _checkStepComplete();
        } else if (view === 'skills') {
          _tourState.skillsViewed = true;
          _checkStepComplete();
        } else if (view === 'recall') {
          _tourState.recallOpened = true;
          _checkStepComplete();
        }
      }
      return result;
    };
  }

  // Listen for recall review actions
  // This will be triggered when user approves/rejects a cognition in Recall
  window.addEventListener('tour:recall-reviewed', () => {
    if (_tourState && !_tourState.completed) {
      _tourState.recallReviewed = true;
      _checkStepComplete();
    }
  });

  // The last two steps navigate inside the Recall panel rather than through
  // `setView`, so watch the clicks that drive them. Capture phase, because the
  // recall module's own delegated handler re-renders the list and replaces the
  // clicked node — reading the intent first keeps this independent of render
  // timing.
  _tourState.onTourClick = (event) => {
    if (!_tourState || _tourState.completed) return;
    const node = event.target;
    if (!node || typeof node.closest !== 'function') return;
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
  if (_tourState.currentStep < TOUR_STEPS.length - 1) {
    _tourState.currentStep++;
    _tourState.targetRetries = 0;
    _showTourStep(_tourState.currentStep);
  } else {
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
  // skipping immediately used to silently drop the step.
  const targetEl = _resolveStepTarget(step);
  if (!targetEl) {
    _tourState.targetRetries = (_tourState.targetRetries || 0) + 1;
    if (_tourState.targetRetries <= 12) {
      _tourLog.warn('tour target not ready, retrying', {
        step: step.id, attempt: _tourState.targetRetries,
      });
      setTimeout(() => {
        if (_tourState && !_tourState.completed && _tourState.currentStep === stepIndex) {
          _showTourStep(stepIndex);
        }
      }, 300);
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
  const tooltipHTML = `
    <div class="tour-tooltip-content">
      <div class="tour-tooltip-header">
        <span class="tour-tooltip-badge">第 ${stepIndex + 1} 步 / 共 ${TOUR_STEPS.length} 步</span>
        <h3 class="tour-tooltip-title">${_tourEsc(step.title)}</h3>
      </div>
      <div class="tour-tooltip-progress"><i style="width:${Math.round(((stepIndex + 1) / TOUR_STEPS.length) * 100)}%"></i></div>
      <p class="tour-tooltip-desc">${_tourEsc(step.description)}</p>
      <div class="tour-tooltip-hint">👆 按提示完成高亮处的操作，自动进入下一步</div>
      <div class="tour-tooltip-actions">
        <button type="button" class="tour-tooltip-btn" data-tour-action="skip">跳过引导</button>
        <button type="button" class="tour-tooltip-btn primary" data-tour-action="next">${
          stepIndex < TOUR_STEPS.length - 1 ? '下一步' : '完成'
        }</button>
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

  // Completion is deliberately not persisted: the tour runs on every launch
  // until the once-per-account prefs gate lands.
}

// Passing the last step used to make the whole tour vanish with no closing
// beat, which reads as the UI glitching rather than as finishing.
function _showTourFinishCard() {
  _tourTooltip.classList.remove('left', 'right', 'top', 'bottom');
  _tourTooltip.classList.add('tour-tooltip-finish');
  _tourTooltip.innerHTML = `
    <div class="tour-tooltip-content">
      <div class="tour-tooltip-header">
        <h3 class="tour-tooltip-title">引导完成</h3>
      </div>
      <p class="tour-tooltip-desc">你刚走通了完整链路：会话 → 提取候选 → 你确认 → 沉淀为正式认知。下次开工时，这些认知会自动跟上——换哪个 AI 都能接着干。随时可从左侧边栏回来。</p>
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
  // Called by recall module when user reviews a cognition
  markRecallReviewed: () => {
    if (_tourState && !_tourState.completed) {
      _tourState.recallReviewed = true;
      _checkStepComplete();
    }
  },
};
