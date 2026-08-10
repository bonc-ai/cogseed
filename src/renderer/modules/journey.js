// ─── Cognition-loop journey (post-onboarding guided tour) ───────────────────
//
// Triggers ONCE after the four-step onboarding completes. Guides the user
// through the REAL cognition loop — 来源 → 沉淀 → 候选 → 确认 → 资产 →
// 本体 → 复用 → 闭环 — using coach marks (spotlight-style UI hints) and
// route navigation. Journey bar tracks progress; timer shows elapsed time.
//
// EVERY node is hands-on: the user must perform a real operation on the real
// UI (open a session, toggle capture, act on a candidate, confirm, open an
// asset, …) before the journey advances. The primary button scrolls/pulses
// the actionable element; if the action target can't exist (empty data, state
// already met), it falls back to a plain「下一步」so the user is never stuck.
//
// Fires once per machine: persisted separately from onboarding so the user can
// complete onboarding first, then experience the journey on the same session
// or a later one. Called by onboarding.js when step 4 finishes.
//
// Hard rule: NO fake data — every coach mark and every required action points
// at a real UI element.

console.log('[journey] journey.js module loading...');

const _jLog = typeof createLogger === 'function' ? createLogger('journey') : { info() {}, warn() {}, error() {} };

console.log('[journey] logger initialized:', _jLog);

let _jBuilt = false;
let _jStep = 1; // current journey node (1..JOURNEY_NODES.length)
let _jTimer = 0; // elapsed seconds
let _jTimerInterval = 0;
let _jTargetPollTimer = 0; // pending retry for an action node's late-rendered target
let _jTargetPollCount = 0; // retries so far (capped, then fall back to the next button)
const _jListened = new Set(); // elements with journey listeners attached (cleaned on stop)

// Journey node definitions: a hands-on tour of the cognition loop that follows
// the four-step onboarding. The onboarding extracted candidates and kept the
// checked ones in the personal-ontology pending pool; this journey then walks
// the REAL pipeline from raw sources to the closing of the loop.
//
// Every node points at real app surfaces and requires one real user action:
//   actionType 'click-any'  → click one of actionSelectors → auto-advance
//   actionType 'toggle-capture' → flip the capture master switch on
//   actionType 'type-composer' → type in the new-chat input / click a chip
//   actionType 'confirm-candidates' → click 个人本体「全部确认」
//   actionConditionMet() → already satisfied → just show「下一步」
const JOURNEY_NODES = [
  {
    id: 1,
    label: '认知从哪来',
    desc: '认知的原料',
    targetSelector: '.recall-source-groups',
    actionSelectors: ['[data-cognition-source-conversation]'],
    actionType: 'click-any',
    view: 'recall',
    subPage: 'deposition',
    depositionView: 'sources',
    title: '认知的原料,你早就有了',
    content: '认知来自你已经在做的事:本地 Agent 的会话、项目文件、执行记录。点开一个会话看看——这就是认知的原料。',
    nextLabel: '去打开',
    nextFocusesTarget: true,
  },
  {
    id: 2,
    label: '持续沉淀',
    desc: '自动提炼管道',
    targetSelector: '[data-recall-capture-enabled]',
    actionType: 'toggle-capture',
    actionConditionMet: () => {
      const cb = document.querySelector('[data-recall-capture-enabled]');
      return !!(cb && cb.checked);
    },
    view: 'recall',
    subPage: 'deposition',
    depositionView: 'captures',
    title: '不用每次手动提炼',
    content: '把沉淀开关打开:会话安静后,它会自动分析新对话、提炼候选认知。(如果开关已经是开的,直接点下一步。)',
    nextLabel: '去开启',
    nextFocusesTarget: true,
  },
  {
    id: 3,
    label: '候选审核',
    desc: '待确认的候选',
    targetSelector: '.skills-cognition-record',
    actionSelectors: ['[data-cognition-candidate-action]', '[data-recall-candidate-action]'],
    actionType: 'click-any',
    view: 'recall',
    subPage: 'deposition',
    depositionView: 'candidates',
    title: '候选:每条都经你之手',
    content: '对任意一条候选执行一个操作(确认、驳回或去个人本体处理)——系统提议,你来决定。',
    nextLabel: '去操作',
    nextFocusesTarget: true,
  },
  {
    id: 4,
    label: '确认入库',
    desc: '确认引导中保留的候选',
    targetSelector: '#personal-onto-confirm-all', // 个人本体·全部确认按钮
    actionType: 'confirm-candidates',
    view: 'personal-ontology',
    title: '确认你的首批认知',
    content: '引导中保留的候选认知就在这里。点击高亮的「全部确认」按钮,让它们成为你的正式资产。',
    nextLabel: '去确认',
    nextFocusesTarget: true,
  },
  {
    id: 5,
    label: '正式资产',
    desc: '查看刚才入库的认知资产',
    targetSelector: '#skills-cognition-assets-body',
    actionSelectors: ['[data-ability-asset-id]', '[data-ability-asset-category]'],
    actionType: 'click-any',
    view: 'recall',
    subPage: 'assets',
    title: '认知,成为你的资产',
    content: '点开一个资产或分类卡片,看看「下一次任务认知注入预览」——这就是换模型、换 Agent,认知都跟着你的地方。',
    nextLabel: '去查看',
    nextFocusesTarget: true,
  },
  {
    id: 6,
    label: '本体模板',
    desc: '角色模板与记忆分组',
    targetSelector: '.ability-asset-ontology-summary',
    actionSelectors: ['[data-ability-asset-category="personal"]', '.ability-asset-ontology-summary .skills-cognition-record'],
    actionType: 'click-any',
    view: 'recall',
    subPage: 'assets',
    assetSubview: 'list',
    category: 'personal',
    title: '认知住进结构里',
    content: '点开一个分组或模板:引导中你选择的角色(如产品负责人)已经为认知提供了结构落点,资产会自动归位。',
    nextLabel: '去查看',
    nextFocusesTarget: true,
  },
  {
    id: 7,
    label: '复用证明',
    desc: '认知被使用的记录',
    targetSelector: '.ability-asset-reuse-summary',
    actionSelectors: ['[data-cognition-open-receipt]', '[data-cognition-open-reuse]'],
    actionType: 'click-any',
    view: 'recall',
    subPage: 'assets',
    assetSubview: 'reuse',
    title: '每次使用都有证明',
    content: '有记录的话,点开一条证明看看它复用了哪些认知;没有就点下一步——去使用你的 Agent,证明会逐渐积累起来。',
    nextLabel: '去查看',
    nextFocusesTarget: true,
  },
  {
    id: 8,
    label: '认知闭环',
    desc: '从来源到复用的流水线',
    targetSelector: '.ability-asset-inline-tree',
    actionSelectors: ['.recall-brain-asset', '[data-cognition-page-link="assets"]'],
    actionType: 'click-any',
    view: 'recall',
    subPage: 'assets',
    assetSubview: 'tree',
    title: '这就是你的认知闭环',
    content: '点击流水线下方的一个资产节点(或「查看正式资产」)。来源 → 候选 → 资产 → 复用:你刚刚亲手走完了这四步。',
    nextLabel: '去查看',
    nextFocusesTarget: true,
  },
  {
    id: 9,
    label: '回到工作台',
    desc: '闭环回到日常',
    targetSelector: '.new-chat-center',
    view: 'new-chat',
    title: '回到你每天工作的地方',
    content: '在输入框里输入一句话,或点一个快捷场景——下次任务,你的认知会在后台悄悄注入。点击下一步完成旅程!',
    nextLabel: '完成旅程',
    // 不使用 actionType，让用户点"完成旅程"按钮直接结束
  },
];

function _jEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _jShellHtml() {
  const nodes = JOURNEY_NODES.map((n) => {
    const icon = n.id === 1 ? '✓' : n.id;
    return `<span class="jb-node ${n.id === 1 ? 'done' : ''}" data-jb="${n.id}"><span class="n">${icon}</span>${_jEsc(n.label)}</span>`;
  }).join('<span class="jb-line"></span>');

  return `
  <div class="journey-bar" id="journeyBar">
    ${nodes}
    <span class="jb-timer" id="jbTimer">00:00</span>
  </div>
  <div class="journey-tip" id="journeyTip"></div>
  <div class="coach-mask" id="coachMask"></div>
  <div class="coach-card" id="coachCard">
    <h3></h3>
    <p></p>
    <div class="coach-actions">
      <button class="coach-btn ghost" id="coachSkip">跳过旅程</button>
      <button class="coach-btn" id="coachNext"></button>
    </div>
  </div>`;
}

function _jBuild() {
  if (_jBuilt) return;
  const container = document.createElement('div');
  container.id = 'cs-journey';
  container.innerHTML = _jShellHtml();
  document.body.appendChild(container);

  document.getElementById('coachSkip')?.addEventListener('click', _jEnd);
  document.getElementById('coachNext')?.addEventListener('click', _jNextNode);

  _jBuilt = true;
}

function _jSet(n) {
  _jStep = Math.max(1, Math.min(JOURNEY_NODES.length, n));
  const nodes = document.querySelectorAll('#journeyBar .jb-node');
  nodes.forEach((node) => {
    const id = Number(node.dataset.jb);
    node.classList.toggle('done', id < _jStep);
    node.classList.toggle('active', id === _jStep);
  });
}

function _jTimerStart() {
  _jTimer = 0;
  _jTimerUpdate();
  clearInterval(_jTimerInterval);
  _jTimerInterval = setInterval(() => {
    _jTimer++;
    _jTimerUpdate();
  }, 1000);
}

function _jTimerStop() {
  clearInterval(_jTimerInterval);
}

function _jTimerUpdate() {
  const timerEl = document.getElementById('jbTimer');
  if (!timerEl) return;
  const min = Math.floor(_jTimer / 60);
  const sec = _jTimer % 60;
  timerEl.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function _jTipShow(html) {
  const tip = document.getElementById('journeyTip');
  if (!tip) return;
  tip.innerHTML = html;
  tip.classList.add('show');
  setTimeout(() => tip.classList.remove('show'), 4000);
}

function _jCoachHide() {
  if (_jTargetPollTimer) {
    clearTimeout(_jTargetPollTimer);
    _jTargetPollTimer = 0;
  }
  _jTargetPollCount = 0;
  document.getElementById('coachMask')?.classList.remove('show');
  document.getElementById('coachCard')?.classList.remove('show');
}

function _jCoachShow(node) {
  const mask = document.getElementById('coachMask');
  const card = document.getElementById('coachCard');
  if (!mask || !card) return;

  let target = node.targetSelector ? document.querySelector(node.targetSelector) : null;
  const isActionNode = !!node.actionType;

  // For click-any nodes the page-level target may exist while NO actionable
  // element does (e.g. an empty receipts list). Only wait when the user has
  // something real to click; otherwise fall back to「下一步」.
  let actionEl = null;
  if (isActionNode && Array.isArray(node.actionSelectors) && node.actionSelectors.length) {
    for (const sel of node.actionSelectors) {
      actionEl = document.querySelector(sel);
      if (actionEl) break;
    }
  }
  const hasAction = isActionNode
    ? (node.actionSelectors && node.actionSelectors.length ? !!actionEl : !!target)
    : !!target;

  // Action nodes need their real target; the view's data loads over IPC so the
  // element may lag behind. Retry briefly before falling back — but never
  // leave the user stuck behind a card with no way forward.
  if (isActionNode && node.targetSelector && !hasAction) {
    if (!_jTargetPollTimer && _jTargetPollCount < 20) {
      _jTargetPollCount++;
      _jTargetPollTimer = window.setTimeout(() => {
        _jTargetPollTimer = 0;
        if (document.getElementById('coachCard')) _jCoachShow(node);
      }, 500);
      return; // Don't render yet, wait for target to appear
    }
    // Polling exhausted, fall through to show fallback "next" button
  }

  // If target doesn't exist and this node should skip, move to next node.
  if (!target && node.skipIfNotExists) {
    _jLog.info('journey node target not found, skipping', { nodeId: node.id, selector: node.targetSelector });
    const nextStep = _jStep + 1;
    if (nextStep <= JOURNEY_NODES.length) {
      _jSet(nextStep);
      setTimeout(() => _jShowNode(nextStep), 300);
    } else {
      _jEnd();
    }
    return;
  }

  // Button policy: an action node keeps a real primary button visible —
  //「去操作」scrolls/pulses the actionable element instead of advancing; the
  // journey only moves on after the user performs the real action. If the
  // target can't exist (empty data) or the state is already met
  // (actionConditionMet), fall back to a plain「下一步」so the user is never
  // trapped.
  const nextBtn = card.querySelector('#coachNext');
  const conditionMet = isActionNode && typeof node.actionConditionMet === 'function'
    ? node.actionConditionMet()
    : false;
  if (isActionNode && !hasAction) {
    if (nextBtn) {
      nextBtn.style.display = '';
      nextBtn.textContent = '下一步';
    }
  } else if (isActionNode && conditionMet) {
    if (nextBtn) {
      nextBtn.style.display = '';
      nextBtn.textContent = '下一步';
    }
  } else if (isActionNode) {
    if (nextBtn) {
      nextBtn.style.display = '';
      nextBtn.textContent = node.nextLabel || '去操作';
    }
    _jStartWaitingForAction(node);
  } else {
    if (nextBtn) {
      nextBtn.style.display = '';
      nextBtn.textContent = node.nextLabel || '下一步';
    }
  }

  // Spotlight + card placement: prefer the actionable element (real clickable
  // thing) over the page-level target; fall back to centered when neither
  // exists.
  const spotlight = actionEl || target;
  if (node.isComingSoon || !spotlight) {
    mask.classList.add('show', 'no-target');
    card.classList.add('show', 'centered');
    card.style.top = '';
    card.style.left = '';
  } else {
    // Position coach card near the target element.
    const rect = spotlight.getBoundingClientRect();
    mask.classList.add('show');
    mask.classList.remove('no-target');
    card.classList.remove('centered');
    card.classList.add('show');

    // Simple positioning: place card below target if space allows, otherwise above.
    const cardWidth = 360;
    const cardHeight = 200; // approximate
    const spaceBelow = window.innerHeight - rect.bottom;

    // Vertical positioning
    let top;
    if (spaceBelow > cardHeight + 40) {
      top = rect.bottom + 20;
    } else {
      top = rect.top - cardHeight - 20;
    }

    // Horizontal positioning: center on target, but keep within viewport
    let left = rect.left + rect.width / 2 - cardWidth / 2;
    // Clamp to viewport with 20px padding
    left = Math.max(20, Math.min(left, window.innerWidth - cardWidth - 20));

    card.style.top = `${top}px`;
    card.style.left = `${left}px`;

    // Highlight target with a spotlight effect (handled by CSS + mask click-through).
    mask.style.setProperty('--spotlight-x', `${rect.left + rect.width / 2}px`);
    mask.style.setProperty('--spotlight-y', `${rect.top + rect.height / 2}px`);
    mask.style.setProperty('--spotlight-w', `${rect.width + 16}px`);
    mask.style.setProperty('--spotlight-h', `${rect.height + 16}px`);
  }

  card.querySelector('h3').textContent = node.title;
  card.querySelector('p').textContent = node.content;
}

function _jShowNode(nodeId) {
  const node = JOURNEY_NODES.find((n) => n.id === nodeId);
  if (!node) {
    _jEnd();
    return;
  }

  _jSet(nodeId);

  // If this node requires navigation, navigate first then show coach mark.
  if (node.view && !node.isComingSoon && !node.noNavigate) {
    _jLog.info('journey navigating to', { view: node.view, subPage: node.subPage });

    // Use the app's navigation system: setView() for main panels
    if (typeof setView === 'function') {
      setView(node.view);
    }

    // If this is a Recall sub-page, switch to it after the main view loads
    if (node.subPage) {
      setTimeout(() => {
        _jSwitchRecallPage(node.subPage, node);
        // For nodes with a target, poll briefly to show coach as soon as target appears
        if (node.targetSelector) {
          _jPollAndShowCoach(node, 800); // Max wait 800ms after subpage switch
        } else {
          // No target to wait for, show immediately
          setTimeout(() => {
            _jCoachShow(node);
          }, 200);
        }
      }, 500);
    } else {
      // No sub-page, just wait for main view to render
      if (node.targetSelector) {
        setTimeout(() => {
          _jPollAndShowCoach(node, 600); // Max wait 600ms
        }, 200);
      } else {
        setTimeout(() => {
          _jCoachShow(node);
        }, 200);
      }
    }
  } else {
    // No navigation needed (coming soon or static info, or already on right page).
    setTimeout(() => {
      _jCoachShow(node);
    }, 200); // Small delay to ensure DOM is ready
  }
}

// Recall sub-page switcher: prefers the app's real switcher (which renders
// the page body from loaded state) and only falls back to a visibility toggle
// when skills.js hasn't loaded yet.
function _jNormalizeRecallLocation(page) {
  const ia = window.RecallInformationArchitecture;
  if (ia && typeof ia.normalizeRecallLocation === 'function') return ia.normalizeRecallLocation(page);
  if (page === 'deposition' || page === 'sources' || page === 'captures' || page === 'candidates') return { page: 'deposition', subview: page === 'deposition' ? 'candidates' : page };
  if (page === 'assets') return { page: 'assets', subview: 'list' };
  return { page: 'overview', subview: '' };
}

function _jApplyRecallNestedLocation(location, options = {}) {
  if (typeof _skillsCognitionState !== 'object') return;
  if (location.page === 'deposition') _skillsCognitionState.depositionView = options.depositionView || location.subview || _skillsCognitionState.depositionView;
  if (location.page === 'assets') {
    _skillsCognitionState.assetSubview = options.assetSubview || location.subview || _skillsCognitionState.assetSubview;
    if (options.category || location.category) _skillsCognitionState.assetCategoryFilter = options.category || location.category;
  }
}

function _jSwitchRecallPage(page, options = {}) {
  const location = _jNormalizeRecallLocation(page);
  if (typeof switchSkillsCognitionPage === 'function') {
    switchSkillsCognitionPage(location.page);
    _jApplyRecallNestedLocation(location, options);
    if (location.page === 'deposition' && typeof renderSkillsCognitionDeposition === 'function') renderSkillsCognitionDeposition();
    if (location.page === 'assets' && typeof renderSkillsCognitionAssets === 'function') renderSkillsCognitionAssets();
    _jLog.info('switched to recall page (real switcher)', { page: location.page, subview: options.depositionView || options.assetSubview || location.subview });
    return;
  }

  _jApplyRecallNestedLocation(location, options);
  const targetPage = location.page || 'overview';

  document.querySelectorAll('[data-cognition-page-body]').forEach((el) => {
    el.hidden = el.dataset.cognitionPageBody !== targetPage;
  });

  document.querySelectorAll('[data-cognition-page]').forEach((el) => {
    const active = el.dataset.cognitionPage === targetPage;
    el.classList.toggle('is-active', active);
    el.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  document.querySelectorAll('[data-cognition-deposition-body]').forEach((el) => {
    el.hidden = el.dataset.cognitionDepositionBody !== (options.depositionView || location.subview || 'candidates');
  });
  document.querySelectorAll('[data-cognition-deposition-view]').forEach((el) => {
    const active = el.dataset.cognitionDepositionView === (options.depositionView || location.subview || 'candidates');
    el.classList.toggle('is-active', active);
    el.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  _jLog.info('switched to recall page (fallback toggle)', { page: targetPage });
}

// Poll briefly for target element to appear, then show coach card as soon as
// it's ready. Avoids both "show too early (black mask)" and "wait too long".
let _jPollTimer = 0;
let _jPollAttempts = 0;
function _jPollAndShowCoach(node, maxWaitMs) {
  const checkInterval = 50; // Check every 50ms
  const maxAttempts = Math.ceil(maxWaitMs / checkInterval);

  function check() {
    const target = node.targetSelector ? document.querySelector(node.targetSelector) : null;
    if (target) {
      // Found it! Show immediately
      clearTimeout(_jPollTimer);
      _jPollTimer = 0;
      _jPollAttempts = 0;
      _jCoachShow(node);
      return;
    }

    _jPollAttempts++;
    if (_jPollAttempts < maxAttempts) {
      // Keep polling
      _jPollTimer = setTimeout(check, checkInterval);
    } else {
      // Timeout, show anyway (will be centered if target still missing)
      clearTimeout(_jPollTimer);
      _jPollTimer = 0;
      _jPollAttempts = 0;
      _jCoachShow(node);
    }
  }

  check();
}

function _jNextNode() {
  const node = JOURNEY_NODES.find((n) => n.id === _jStep);
  if (!node) return;

  // The primary button is a focus helper ONLY while a real action is waiting
  // (a waiter poll is live). When the node fell back to「下一步」(nothing
  // actionable, or the required state is already met), the button advances
  // like a normal next button.
  if (node.nextFocusesTarget && node.targetSelector && _jActionListener !== null) {
    _jFocusTarget(node);
    return;
  }

  // Stop waiting for actions when leaving a node
  _jStopWaitingForAction();

  _jCoachHide();

  // Advance to next step.
  const nextStep = _jStep + 1;
  if (nextStep <= JOURNEY_NODES.length) {
    setTimeout(() => _jShowNode(nextStep), 300);
  } else {
    _jEnd();
  }
}

// Scroll the real actionable element into view and pulse it, then re-position
// the coach card for the post-scroll location. Does NOT advance the journey.
function _jFocusTarget(node) {
  // Prefer the first actionable selector over the page-level spotlight target.
  const sel = (node.actionSelectors && node.actionSelectors.length)
    ? node.actionSelectors[0]
    : node.targetSelector;
  const el = sel ? document.querySelector(sel) : null;
  if (!el) return;
  _jLog.info('journey focusing target', { nodeId: node.id, selector: sel });
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('jb-pulse');
  setTimeout(() => el.classList.remove('jb-pulse'), 2000);
  // Re-show the coach card after scrolling so the spotlight follows the button.
  setTimeout(() => {
    if (document.getElementById('coachCard')) _jCoachShow(node);
  }, 500);
}

function _jEnd() {
  _jStopWaitingForAction();
  _jCoachHide();
  _jTimerStop();
  _jSet(JOURNEY_NODES.length);
  _jTipShow('<b>认知闭环之旅完成</b><br>你已亲手走完 来源 → 确认 → 资产 → 复用 的完整闭环,开始使用吧!');

  // Persist journey completion.
  void _jPersistCompletion();

  // Hide journey bar and coach UI after a delay.
  setTimeout(() => {
    document.getElementById('journeyBar')?.classList.remove('show');
    document.getElementById('cs-journey')?.remove();
  }, 5000);
}

async function _jPersistCompletion() {
  try {
    await window.orkas.invoke('prefs.setJourney', { completed: true });
    _jLog.info('journey completed and persisted');
  } catch (err) {
    _jLog.warn('failed to persist journey completion', { error: (err && err.message) || String(err) });
  }
}

async function _jShouldStart() {
  console.log('[journey] _jShouldStart called');

  // Dev override lives on the MAIN side (journey_state.ts, ORKAS_JOURNEY_ALWAYS=1)
  // so `prefs.getJourney` already reports "not completed" — no renderer-side check needed.
  try {
    const res = await window.orkas.invoke('prefs.getJourney');
    console.log('[journey] prefs.getJourney result:', res);
    const shouldStart = !(res && res.completed === true);
    console.log('[journey] should start:', shouldStart);
    return shouldStart;
  } catch (err) {
    // If reading the marker fails (e.g., file doesn't exist yet),
    // assume journey hasn't been completed — allow it to start.
    console.log('[journey] prefs.getJourney failed:', err);
    _jLog.warn('journey marker read failed, assuming not completed', { error: (err && err.message) || String(err) });
    return true;
  }
}

// Called by onboarding.js after step 4 completes. Fire-and-forget.
async function startJourney() {
  // Use electron-log to write to main process log (visible in terminal)
  if (window.orkas && window.orkas.log) {
    window.orkas.log('info', '[journey] startJourney called');
  }
  console.log('[journey] startJourney called');
  _jLog.info('journey startJourney called');

  const should = await _jShouldStart();
  if (window.orkas && window.orkas.log) {
    window.orkas.log('info', '[journey] should start? ' + should);
  }
  console.log('[journey] should start?', should);

  if (!should) {
    if (window.orkas && window.orkas.log) {
      window.orkas.log('info', '[journey] journey already completed, skipping');
    }
    console.log('[journey] journey already completed, skipping');
    _jLog.info('journey already completed, skipping');
    return;
  }

  if (window.orkas && window.orkas.log) {
    window.orkas.log('info', '[journey] building journey UI');
  }
  console.log('[journey] building journey UI');
  _jBuild();

  const bar = document.getElementById('journeyBar');
  if (window.orkas && window.orkas.log) {
    window.orkas.log('info', '[journey] journeyBar element: ' + (bar ? 'found' : 'NOT FOUND'));
  }
  console.log('[journey] journeyBar element:', bar);

  if (bar) {
    bar.classList.add('show');
    if (window.orkas && window.orkas.log) {
      window.orkas.log('info', '[journey] added show class to journey bar');
    }
    console.log('[journey] added show class to journey bar');
  }

  _jTimerStart();
  if (window.orkas && window.orkas.log) {
    window.orkas.log('info', '[journey] timer started, showing node 1');
  }
  console.log('[journey] timer started');

  _jShowNode(1);
  console.log('[journey] showing node 1');

  _jLog.info('journey started');
}

// Expose for onboarding.js.
window.csJourney = { start: startJourney };

console.log('[journey] window.csJourney exposed:', window.csJourney);
console.log('[journey] journey.js module loaded successfully');

// ─── Wait for user actions ───────────────────────────────────────────────

let _jActionListener = null;

function _jStartWaitingForAction(node) {
  if (node.actionType === 'confirm-candidates') return _jWaitForCandidateConfirm();
  if (node.actionType === 'click-any') return _jWaitForAnyClick(node);
  if (node.actionType === 'toggle-capture') return _jWaitForCaptureToggle(node);
  if (node.actionType === 'type-composer') return _jWaitForComposerInput(node);
}

// Shared completion path: the user performed the required action → stop all
// listening, hide the coach card, advance. `delayMs` lets in-flight IPC round
// trips (confirm, capture settings) land before the next node navigates.
function _jActionDone(node, delayMs) {
  _jLog.info('journey action performed', { nodeId: node.id, actionType: node.actionType });
  setTimeout(() => {
    _jStopWaitingForAction();
    _jCoachHide();
    _jShowNode(_jStep + 1);
  }, delayMs || 900);
}

function _jWaitForAnyClick(node) {
  _jStopPolling();
  const selectors = Array.isArray(node.actionSelectors) ? node.actionSelectors : [];
  const attach = () => {
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((el) => {
        if (el.dataset.journeyListening) return;
        el.dataset.journeyListening = '1';
        _jListened.add(el);
        el.addEventListener('click', () => _jActionDone(node, 600));
      });
    }
  };
  attach();
  _jActionListener = setInterval(attach, 500);
}

function _jWaitForCaptureToggle(node) {
  _jStopPolling();
  const attach = () => {
    const cb = document.querySelector('[data-recall-capture-enabled]');
    if (!cb || cb.dataset.journeyListening) return;
    cb.dataset.journeyListening = '1';
    _jListened.add(cb);
    cb.addEventListener('change', () => {
      if (cb.checked) _jActionDone(node, 1200);
    });
  };
  attach();
  _jActionListener = setInterval(attach, 500);
}

function _jWaitForComposerInput(node) {
  _jStopPolling();
  const attach = () => {
    const ta = document.getElementById('new-chat-input');
    if (ta && !ta.dataset.journeyListening) {
      ta.dataset.journeyListening = '1';
      _jListened.add(ta);
      ta.addEventListener('input', () => _jActionDone(node, 400));
    }
    document.querySelectorAll('.new-chat-scenario-chip').forEach((chip) => {
      if (chip.dataset.journeyListening) return;
      chip.dataset.journeyListening = '1';
      _jListened.add(chip);
      chip.addEventListener('click', () => _jActionDone(node, 400));
    });
  };
  attach();
  _jActionListener = setInterval(attach, 500);
}

function _jWaitForCandidateConfirm() {
  // Listen for the user clicking the "confirm all" button in personal ontology.
  // The button ID is #personal-onto-confirm-all.
  //
  // personal-ontology.js binds its real handler with addEventListener, so we
  // only ADD a detector listener — never override onclick — and keep the
  // app's own confirm flow untouched.

  _jLog.info('waiting for candidate confirmation');

  _jStopPolling();

  const checkAndAttach = () => {
    const confirmBtn = document.getElementById('personal-onto-confirm-all');
    if (confirmBtn && !confirmBtn.dataset.journeyListening) {
      confirmBtn.dataset.journeyListening = '1';
      _jListened.add(confirmBtn);

      confirmBtn.addEventListener('click', () => {
        _jLog.info('candidate confirmation detected, advancing journey');
        // Wait for the confirm IPC round-trip + list re-render before advancing.
        _jActionDone(JOURNEY_NODES.find((n) => n.id === _jStep) || {}, 1500);
      });
    }
  };

  // Check immediately and periodically (in case button gets re-rendered)
  checkAndAttach();
  _jActionListener = setInterval(checkAndAttach, 500);
}

function _jStopPolling() {
  if (_jActionListener) {
    clearInterval(_jActionListener);
    _jActionListener = null;
  }
}

function _jStopWaitingForAction() {
  _jStopPolling();

  // Clean up listeners/flag markers on every element the journey touched.
  for (const el of _jListened) {
    delete el.dataset.journeyListening;
  }
  _jListened.clear();
}

