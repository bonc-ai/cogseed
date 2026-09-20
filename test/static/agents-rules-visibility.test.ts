/**
 * Static tripwire: the file an AI harness injects must still state the shared Renderer contract.
 *
 * Why this exists:
 *   `AGENTS.md` is tracked, and AI harnesses inject it into the model context. A working copy may
 *   legitimately diverge from the committed file (`git update-index --skip-worktree AGENTS.md` plus
 *   a local instruction file), for example to keep internal process docs out of the public repo.
 *   Two properties make that dangerous:
 *     - `git status` stays clean, so nothing looks wrong;
 *     - `git pull` never updates the file again, so a missing rule never comes back on its own.
 *   If the replacement drops the repository's engineering rules, the contract silently disappears
 *   from the model's context: models then hand-roll buttons, form controls, modals and empty states
 *   instead of using the shared primitives. That failure is invisible until someone notices the
 *   drift in review — this test makes it loud instead.
 *
 * What it asserts:
 *   - clean clone / CI: the committed `AGENTS.md` is the injected file and carries the rules → green;
 *   - locally replaced `AGENTS.md` that lost the rules → red, with the concrete remediation.
 *
 * Choosing the markers (two false verdicts already observed, both on 2026-09-20):
 *   - too loose: `Shared Renderer primitives` / `cogseed-component-change` also appear in prose that
 *     merely *talks about* the rules — a replacement file that discusses them but no longer states
 *     them passed. So the markers below are **rule body** strings (the primitive list, the named
 *     primitives, the frozen-baseline clause), which plain prose about the rules does not contain.
 *   - too eager: a marker quoted in a doc example looked like a truncated block. Code spans and
 *     fenced blocks are stripped before the pairing check (see `withoutCodeSpans`).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');

/** Files an AI harness may auto-inject as instructions. `CLAUDE.md` is a pointer in this repo. */
const INJECTED_FILES = ['AGENTS.md', 'CLAUDE.md'];

/**
 * The shared Renderer contract, as **rule body** text (not concept names): the primitive list, two
 * named primitives, the frozen raw-control baseline clause, and the mandatory component-change skill
 * pointer. All four are literal lines of the committed `## Renderer` section; a document that only
 * *mentions* these concepts must not satisfy the check (see the self-check test).
 */
const REQUIRED_RULE_MARKERS = [
  'Shared Renderer primitives are',
  'uiModalController(',
  'freezes the legacy raw-control baseline',
  'cogseed-component-change',
];

function readIfExists(relativePath: string): string {
  const file = path.join(root, relativePath);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function hasAllRules(text: string): boolean {
  return REQUIRED_RULE_MARKERS.every((marker) => text.includes(marker));
}

/** The `AGENTS.md` this commit ships; `null` when git history is unavailable (exported tarball etc.). */
function committedAgentsMd(): string | null {
  try {
    return execFileSync('git', ['show', 'HEAD:AGENTS.md'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * Documentation examples are not markers: strip fenced code blocks and inline code spans
 * before scanning. Without this, a doc that merely *mentions* a marker (e.g. an instruction
 * file explaining its own sync block) looks like a truncated block and turns this test red.
 * Found the hard way on 2026-09-20: the same working copy passed in a clean clone and failed
 * once a local instruction file quoted the marker inline.
 */
function withoutCodeSpans(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

/** Paired marker names worth checking, e.g. `<!-- BEGIN: some-block -->` on its own line. */
function beginMarkerNames(text: string): string[] {
  return [...withoutCodeSpans(text).matchAll(/<!--\s*BEGIN:\s*([A-Za-z0-9_.-]+)/g)].map((m) => m[1]!);
}

describe('AI 注入文件必须带上共享组件规范', () => {
  const injected = INJECTED_FILES.map((name) => ({ name, text: readIfExists(name) }));
  const localAgents = injected.find((f) => f.name === 'AGENTS.md')!.text;
  const committed = committedAgentsMd();
  const replacedLocally = committed !== null && committed.trim() !== localAgents.trim();

  it('工作区 AGENTS.md 未被替换时：它本身就带规则（干净 clone / CI 不误报）', () => {
    if (replacedLocally) return; // 本机替换场景交给下一条断言

    expect(
      hasAllRules(localAgents),
      '仓库里的 AGENTS.md 丢了共享组件条款——这是仓库自身的回归，请检查本次改动是否删掉了 `## Renderer` 的规则',
    ).toBe(true);
  });

  it('工作区 AGENTS.md 被本地替换时：注入文件里仍能读到规则', () => {
    if (!replacedLocally) return; // 干净 clone，上一条已覆盖

    // 判据是"**至少一个**注入文件含全部规则"：本仓库约定 `CLAUDE.md` 只做指向 `AGENTS.md` 的
    // 指针（重复的规则副本会漂移），所以不能要求它也带规则正文。
    if (injected.some((file) => file.text && hasAllRules(file.text))) return;

    const detail = injected
      .filter((file) => file.text)
      .map((file) => `  - ${file.name}：缺 ${REQUIRED_RULE_MARKERS.filter((m) => !file.text.includes(m)).join('、') || '（无）'}`)
      .join('\n');

    throw new Error(
      [
        '工作区的 AGENTS.md 与本次提交不一致（本地替换，git add 带不走、git pull 也不会更新），',
        '但 AI 注入的指令文件里读不到共享组件规范：',
        detail,
        '后果：模型看不到「共享原语清单 / 图标来自 icons.js / 层序用 --z-* / 必须读组件变更 skill」等条款，',
        '      会自己手搓按钮、弹窗与空态，diff 里看不出对错。',
        '修法（任选其一）：',
        '  1) 恢复仓库版本：git update-index --no-skip-worktree AGENTS.md && git checkout -- AGENTS.md',
        '  2) 必须保留本地替换文件时：把 `## Renderer` 一节（含共享原语与 cogseed-component-change 指针）并入该文件，',
        '     并保持它随本文件一起更新（每次 `git pull` 后自查一次）。',
      ].join('\n'),
    );
  });

  it('注入文件里的成对标记没有半截：BEGIN 必须有对应 END', () => {
    for (const file of injected) {
      if (!file.text) continue;
      for (const name of beginMarkerNames(file.text)) {
        expect(
          file.text.includes(`<!-- END: ${name}`),
          `${file.name} 里的 "${name}" 标记只有 BEGIN 没有 END——文件被手工截断过，请按生成它的工具重新生成`,
        ).toBe(true);
      }
    }
  });

  it('绊线自检：判据本身能识别违规（写坏的判据不能让闸门静默放行）', () => {
    // 规则判据：缺任一标记即为违规
    expect(hasAllRules('Renderer buttons go through uiButton(...)')).toBe(false);
    expect(
      hasAllRules(
        'Shared Renderer primitives are `uiButton(...)`, `uiIconButton(...)`, … `uiModalController(...)`, '
          + '`uiPageHeader(...)`; … follow `.agents/skills/cogseed-component-change/SKILL.md`; … '
          + '`test/renderer/shared-ui-adoption-guard.test.ts` freezes the legacy raw-control baseline;',
      ),
    ).toBe(true);
    // **最关键的一条**：只是"谈论"规则的文件不算带规则。文档里引用概念名（甚至引用原语名）不足以
    // 满足判据——否则讲解规则的文档自己就会把红灯骗成绿灯（2026-09-20 实测：v0.9/v0.10 手册正文
    // 引用了 Shared Renderer primitives 与 cogseed-component-change，于是"没装同步"也被判绿）
    expect(
      hasAllRules(
        '公开 AGENTS.md 里混着对内工程约束：`## Renderer`（共享组件原语清单、checkbox 规则）、`## i18n`；'
          + '实测本地手册里 `Shared Renderer primitives`、`cogseed-component-change` 命中 0 次。',
      ),
    ).toBe(false);
    // 成对标记判据：只有 BEGIN 的文件必须被识别为半截
    expect(beginMarkerNames('<!-- BEGIN: public-agents-sync --> body <!-- END: public-agents-sync -->')).toEqual([
      'public-agents-sync',
    ]);
    expect(beginMarkerNames('<!-- BEGIN: some-block（带说明后缀） --> body')).toEqual(['some-block']);
    // 文档里的"示例"不是标记：行内代码与围栏代码块内的 BEGIN 必须被忽略，否则讲解自己的同步块
    // 就会变成假红（2026-09-20 实测：干净 clone 绿、装了本地指令文件后反而红）
    expect(beginMarkerNames('说明：`<!-- BEGIN: x -->` 必须有对应 END')).toEqual([]);
    expect(beginMarkerNames('```markdown\n<!-- BEGIN: demo -->\n```\n')).toEqual([]);
    expect(beginMarkerNames('> 引用里的示例 `<!-- BEGIN: y -->` 同样忽略')).toEqual([]);
    // 但真标记（不在代码里）仍必须被发现
    expect(beginMarkerNames('# 文档\n<!-- BEGIN: real-block -->\n正文\n<!-- END: real-block -->')).toEqual([
      'real-block',
    ]);
  });
});
