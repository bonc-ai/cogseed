#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

/**
 * RC-T05 — Run Center layout smoke, fixed at four viewport widths.
 *
 * Why a separate script rather than a unit test: jsdom performs no layout, so
 * `getBoundingClientRect()` is permanently zero there and an assertion like
 * "the completed column is on screen" would pass unconditionally. The bug this
 * guards (RC-P0-06 / F-20) was invisible to every unit test precisely because
 * it was a layout bug — at 1456px the completed column held eight cards
 * entirely off-screen with no scrollbar, and the board read as "no data".
 *
 * This drives the real app over the Chrome DevTools Protocol and asserts on
 * real rectangles. It is a LOCAL script and is deliberately NOT part of CI.
 *
 * Usage:
 *   1. Start the app with the debugging port open:
 *        ./node_modules/.bin/electron . --remote-debugging-port=9222
 *   2. Run:
 *        npm run smoke:run-center
 *      or  node scripts/run-center-layout-smoke.mjs [--port 9222] [--json]
 *
 * Exit code is 0 only if every check at every width passes.
 * Node 24 ships WebSocket, so this has no dependencies.
 */

import http from 'node:http';

const WIDTHS = [720, 1050, 1456, 1920];
const HEIGHT = 900;
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || 9222;
const asJson = args.includes('--json');

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

const target = await new Promise((resolve, reject) => {
  http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      try { resolve(JSON.parse(body)[0]); } catch (error) { reject(error); }
    });
  }).on('error', reject);
}).catch(() => fail(
  `No CDP target on port ${port}. Start the app first:\n`
  + '  ./node_modules/.bin/electron . --remote-debugging-port=9222',
));

const ws = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++nextId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
await new Promise((resolve) => ws.addEventListener('open', resolve));

const evaluate = async (expression) => {
  const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.text);
  return reply.result?.result?.value;
};
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs inside the page. Returns raw measurements only — every verdict is
 * decided here in Node so the assertions live in one place.
 */
const PROBE = `(() => {
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  const main = q('.run-center-main');
  const mainRect = main ? main.getBoundingClientRect() : null;
  const columns = qa('.dashboard-board-column').map((column) => {
    const rect = column.getBoundingClientRect();
    return {
      key: column.dataset.dashboardBoardColumn,
      right: Math.round(rect.right),
      left: Math.round(rect.left),
      width: Math.round(rect.width),
      cards: column.querySelectorAll('.dashboard-board-card').length,
    };
  });
  const overflowingCards = qa('.dashboard-board-card').filter((card) => {
    const cardRect = card.getBoundingClientRect();
    const columnRect = card.closest('.dashboard-board-column').getBoundingClientRect();
    return cardRect.right > columnRect.right + 1 || cardRect.left < columnRect.left - 1;
  }).length;
  const visible = (node) => {
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  return {
    documentScrollsHorizontally: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    mainRight: mainRect ? Math.round(mainRect.right) : null,
    columns,
    overflowingCards,
    controls: {
      tabs: qa('.run-center-tab').filter(visible).length,
      search: visible(q('[data-run-center-search]')),
      filtersVisible: qa('.run-center-filter').filter(visible).length,
      filtersEnabled: qa('.run-center-filter:not([disabled])').length,
    },
    identities: qa('.dashboard-board-card [data-run-center-identity]').map((n) => n.textContent.replace(/\\s+/g, ' ').trim()),
    cardCount: qa('.dashboard-board-card').length,
    resumeButtons: qa('[data-run-center-action="resume"]').length,
    deadOpenButtons: qa('[data-run-center-open=""]').length,
  };
})()`;

const RUNS_PROBE = `(() => {
  const qa = (s) => [...document.querySelectorAll(s)];
  const filters = document.querySelector('.run-center-filters');
  return {
    activeView: document.querySelector('.run-center-tab.is-active')?.dataset.runCenterView ?? null,
    filtersHidden: !filters || filters.hasAttribute('hidden'),
    filtersEnabled: qa('.run-center-filter:not([disabled])').length,
    treeIdentities: qa('.run-center-tree-task [data-run-center-identity]').map((n) => n.textContent.replace(/\\s+/g, ' ').trim()),
    treeNodes: qa('.run-center-tree-task').length,
    resumeButtons: qa('[data-run-center-action="resume"]').length,
  };
})()`;

const DETAIL_PROBE = `(() => {
  const open = document.querySelector('[data-run-center-open]');
  return {
    openLabel: open ? open.textContent.trim() : null,
    openTarget: open ? open.dataset.runCenterOpen : null,
    conversationUnavailable: !!document.querySelector('[data-run-center-conversation-unavailable]'),
    unavailableHasOpen: !!(document.querySelector('[data-run-center-conversation-unavailable]')
      && document.querySelector('[data-run-center-open]')),
    resumeButtons: document.querySelectorAll('[data-run-center-action="resume"]').length,
  };
})()`;

const results = [];
let failures = 0;

function check(width, name, ok, detail) {
  results.push({ width, name, ok, detail });
  if (!ok) failures += 1;
  if (!asJson) {
    const mark = ok ? '✔' : '✖';
    console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

for (const width of WIDTHS) {
  if (!asJson) console.log(`\n▸ ${width}px`);
  await send('Emulation.setDeviceMetricsOverride', { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await evaluate("document.getElementById('run-center-btn')?.click()");
  await settle(1200);
  await evaluate(`(() => {
    const board = [...document.querySelectorAll('.run-center-tab')].find((t) => t.dataset.runCenterView === 'board');
    if (board && !board.classList.contains('is-active')) board.click();
  })()`);
  await settle(900);

  const board = await evaluate(PROBE);

  check(width, 'four board columns present',
    board.columns.length === 4,
    `${board.columns.length} columns`);

  const clipped = board.columns.filter((column) => column.right > board.mainRight + 1);
  check(width, 'no column clipped past the main pane',
    clipped.length === 0,
    clipped.length ? `clipped: ${clipped.map((c) => `${c.key}(right=${c.right} > ${board.mainRight})`).join(', ')}` : `mainRight=${board.mainRight}`);

  check(width, 'page does not scroll horizontally',
    !board.documentScrollsHorizontally);

  check(width, 'no card overflows its column',
    board.overflowingCards === 0,
    `${board.overflowingCards} overflowing`);

  check(width, 'controls visible (tabs + search + filters)',
    board.controls.tabs >= 3 && board.controls.search && board.controls.filtersVisible === 4,
    `tabs=${board.controls.tabs} search=${board.controls.search} filters=${board.controls.filtersVisible}`);

  check(width, 'board filters enabled',
    board.controls.filtersEnabled === 4,
    `${board.controls.filtersEnabled}/4`);

  check(width, 'no resume offered anywhere',
    board.resumeButtons === 0);

  check(width, 'no empty Open Conversation target',
    board.deadOpenButtons === 0);

  if (board.cardCount > 0) {
    const unique = new Set(board.identities);
    check(width, 'every card identity is distinct',
      board.identities.length === board.cardCount && unique.size === board.identities.length,
      `${unique.size} distinct / ${board.cardCount} cards`);
  } else {
    check(width, 'every card identity is distinct', true, 'no cards on this board');
  }

  // Runs view: filters must not imply a scope they do not have (RC-P2-11).
  await evaluate(`(() => {
    const runs = [...document.querySelectorAll('.run-center-tab')].find((t) => t.dataset.runCenterView === 'runs');
    runs?.click();
  })()`);
  await settle(700);
  const runs = await evaluate(RUNS_PROBE);

  check(width, 'runs view hides and disables the board filters',
    runs.activeView === 'runs' && runs.filtersHidden && runs.filtersEnabled === 0,
    `view=${runs.activeView} hidden=${runs.filtersHidden} enabled=${runs.filtersEnabled}`);

  check(width, 'runs tree identities are distinct',
    new Set(runs.treeIdentities).size === runs.treeIdentities.length,
    `${runs.treeIdentities.length} entries`);

  check(width, 'runs view offers no resume',
    runs.resumeButtons === 0);

  // Detail: the exit must be labelled as opening a conversation, and a task
  // whose conversation is gone must not offer one at all (RC-P1-14 (c)).
  await evaluate(`(() => {
    const board = [...document.querySelectorAll('.run-center-tab')].find((t) => t.dataset.runCenterView === 'board');
    board?.click();
    document.querySelector('.dashboard-board-card')?.click();
  })()`);
  await settle(900);
  const detail = await evaluate(DETAIL_PROBE);

  if (detail.openLabel !== null) {
    check(width, 'exit is labelled as opening a conversation',
      /conversation|会话/i.test(detail.openLabel) && !/retry|resume|重试|恢复/i.test(detail.openLabel),
      `label="${detail.openLabel}"`);
    check(width, 'exit points at a real conversation',
      !!detail.openTarget);
  } else {
    check(width, 'exit is labelled as opening a conversation', true, 'no exit on this task');
    check(width, 'exit points at a real conversation', true, 'no exit on this task');
  }

  check(width, 'a deleted-conversation task offers no exit',
    !detail.unavailableHasOpen,
    detail.conversationUnavailable ? 'task reports conversation unavailable' : 'not applicable');

  check(width, 'detail offers no resume',
    detail.resumeButtons === 0);
}

await send('Emulation.clearDeviceMetricsOverride');
ws.close();

if (asJson) {
  console.log(JSON.stringify({ widths: WIDTHS, failures, results }, null, 2));
} else {
  console.log(`\n${failures === 0 ? '✔ all checks passed' : `✖ ${failures} check(s) failed`} across ${WIDTHS.join(' / ')}px`);
}
process.exit(failures === 0 ? 0 : 1);
