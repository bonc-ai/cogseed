/**
 * Daily briefing generator — 今日简报生成器原型测试（fixture 驱动）。
 *
 * Fixture 目录：`test/fixtures/briefing/*.json`，每个 fixture 自带
 * `expected` 块（degraded / missingData / sectionKeys / contains /
 * notContains），覆盖：
 *   - full.json       完整数据 → 非降级，全段落
 *   - no-events.json  无日历事件 → 降级（缺失 events）
 *   - no-facts.json   无本体事实 → 降级（缺失 facts）
 *   - empty.json      数据全缺 → 通用简报
 *   - edge.json       脏数据/边界 → 静默过滤、不崩
 *
 * 补充用例（fixture 之外）：
 *   - 非法 `now` 回退当前时间（防御，不抛错）
 *   - copy 注入：自定义文案与 locale 生效
 *   - 输出文本段落顺序稳定
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildDailyBriefing,
  type BriefingInput,
  type BriefingOutput,
  type BriefingSectionKey,
  type MissingDataKind,
} from '../../../src/main/features/personal_context/briefing';

const FIXTURES_DIR = path.join(__dirname, '../../fixtures/briefing');

interface FixtureExpected {
  degraded: boolean;
  missingData: MissingDataKind[];
  sectionKeys: BriefingSectionKey[];
  contains: string[];
  notContains: string[];
}

interface Fixture {
  description: string;
  now: string;
  facts: unknown[];
  events: unknown[];
  expected: FixtureExpected;
}

function loadFixtures(): Array<{ name: string; fx: Fixture }> {
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({
      name: f.replace(/\.json$/, ''),
      fx: JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), 'utf8')) as Fixture,
    }));
}

function runFixture(fx: Fixture): BriefingOutput {
  const input: BriefingInput = {
    facts: fx.facts as BriefingInput['facts'],
    events: fx.events as BriefingInput['events'],
    now: fx.now,
  };
  return buildDailyBriefing(input);
}

describe('personal_context/briefing — fixture 驱动', () => {
  for (const { name, fx } of loadFixtures()) {
    it(`[${name}] ${fx.description}`, () => {
      const out = runFixture(fx);
      const exp = fx.expected;

      expect(out.degraded).toBe(exp.degraded);
      expect(out.missingData).toEqual(exp.missingData);
      expect(out.sections.map((s) => s.key)).toEqual(exp.sectionKeys);

      for (const needle of exp.contains) {
        expect(out.text, `期望包含「${needle}」`).toContain(needle);
      }
      for (const needle of exp.notContains) {
        expect(out.text, `不应包含「${needle}」`).not.toContain(needle);
      }
      expect(out.text.trim().length).toBeGreaterThan(0);
    });
  }

  it('降级不阻塞：数据全缺仍产出非空文本（推送方可直接使用）', () => {
    const out = buildDailyBriefing({ facts: [], events: [], now: '2026-08-10T08:00:00' });
    expect(out.degraded).toBe(true);
    expect(out.text).toContain('今日简报');
  });
});

describe('personal_context/briefing — 防御与扩展点', () => {
  it('非法 now 回退当前时间，不抛错（脏调度输入防御）', () => {
    const out = buildDailyBriefing({
      facts: [{ id: 'f1', kind: 'preference', summary: 'X' }],
      events: [],
      now: 'not-a-time',
    });
    expect(out.text).toContain('今日简报');
    expect(out.sections.some((s) => s.key === 'notes')).toBe(true);
  });

  it('缺省 input 字段（undefined）等价于空数据 → 通用简报', () => {
    const out = buildDailyBriefing({});
    expect(out.degraded).toBe(true);
    expect(out.missingData).toEqual(['facts', 'events']);
    expect(out.sections.map((s) => s.key)).toEqual(['generic']);
  });

  it('copy 注入：自定义文案与 locale 生效（i18n 扩展点）', () => {
    const out = buildDailyBriefing(
      {
        facts: [{ id: 'f1', kind: 'deadline', summary: 'Paper', date: '2026-08-12' }],
        events: [],
        now: '2026-08-10T08:00:00',
      },
      {
        header: 'Daily Briefing',
        todaySchedule: 'Today',
        upcomingDeadlines: 'Deadlines',
        freeSlot: 'Free time',
        notes: 'Notes',
        generic: 'No data yet.',
        missingEventsHint: 'No calendar events.',
        missingFactsHint: 'No facts yet.',
        noDeadlines: 'No deadlines in 7 days.',
        locale: 'en-US',
        timeFormatter: (d: Date) => d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
        dateFormatter: (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      },
    );
    expect(out.text).toContain('Daily Briefing');
    expect(out.text).toContain('Deadlines');
    expect(out.text).toContain('Paper');
    expect(out.text).toContain('No calendar events.');
  });

  it('输出段落顺序稳定：today_schedule → upcoming_deadlines → free_slot → notes → generic 提示', () => {
    const out = runFixture(loadFixtures().find((f) => f.name === 'full')!.fx);
    const keys = out.sections.map((s) => s.key);
    const order = ['today_schedule', 'upcoming_deadlines', 'free_slot', 'notes'];
    expect(keys).toEqual(order);
  });
});
