import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const auto = require('../../src/renderer/modules/auto.js') as {
  _AUTO_TEMPLATES: Array<{
    id: string;
    icon: string;
    schedule:
      | null
      | { type: 'daily'; hour: number; minute: number }
      | { type: 'weekly'; weekday: number; hour: number; minute: number }
      | { type: 'monthly'; day: number; hour: number; minute: number };
  }>;
};

// Mirror of the backend guards in `src/main/features/auto_tasks.ts`. The
// starter templates pre-fill the create form, so any schedule they seed must
// pass main's validation verbatim — otherwise the user hits "invalid schedule"
// on save. Keep these in lockstep with `_isHM` / `_isValidSchedule`.
function isHM(h: unknown, m: unknown): boolean {
  return Number.isInteger(h) && (h as number) >= 0 && (h as number) <= 23
    && Number.isInteger(m) && (m as number) >= 0 && (m as number) <= 59;
}
function isValidSchedule(s: any): boolean {
  if (!s || typeof s !== 'object') return false;
  if (s.type === 'daily') return isHM(s.hour, s.minute);
  if (s.type === 'weekly') {
    return isHM(s.hour, s.minute)
      && Number.isInteger(s.weekday) && s.weekday >= 0 && s.weekday <= 6;
  }
  if (s.type === 'monthly') {
    return isHM(s.hour, s.minute)
      && Number.isInteger(s.day) && s.day >= 1 && s.day <= 31;
  }
  return false;
}

function loadLocale(name: string): Record<string, string> {
  const p = path.join(__dirname, '..', '..', 'src', 'renderer', 'locales', `${name}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

describe('auto starter templates', () => {
  const templates = auto._AUTO_TEMPLATES;

  it('exposes the six starter templates plus a blank entry', () => {
    const ids = templates.map((t) => t.id);
    expect(ids).toEqual([
      'tech_news',
      'daily_wrapup',
      'meeting_prep',
      'weekly_report',
      'project_health',
      'monthly_admin',
      'blank',
    ]);
  });

  it('gives every non-blank template a schedule main accepts', () => {
    for (const tpl of templates) {
      if (tpl.id === 'blank') {
        expect(tpl.schedule).toBeNull();
        continue;
      }
      expect(isValidSchedule(tpl.schedule), `schedule for ${tpl.id}`).toBe(true);
    }
  });

  it('maps the workday-style cadences down to daily (method A fallback)', () => {
    // Under method A there is no "weekdays" schedule; these fire every day.
    const daily = ['tech_news', 'daily_wrapup', 'meeting_prep', 'project_health'];
    for (const id of daily) {
      const tpl = templates.find((t) => t.id === id)!;
      expect(tpl.schedule?.type, id).toBe('daily');
    }
  });

  it('keeps the natively-supported cadences intact', () => {
    const weekly = templates.find((t) => t.id === 'weekly_report')!;
    expect(weekly.schedule).toMatchObject({ type: 'weekly', weekday: 5, hour: 17, minute: 30 });
    const monthly = templates.find((t) => t.id === 'monthly_admin')!;
    expect(monthly.schedule).toMatchObject({ type: 'monthly', day: 25, hour: 10, minute: 0 });
  });

  it('has name/desc/seed/title i18n keys for every template in zh and en', () => {
    for (const locale of ['zh', 'en']) {
      const dict = loadLocale(locale);
      // Empty-state chrome + compact "add from template" heading.
      for (const key of ['auto.subtitle', 'auto.empty_title', 'auto.empty_subtitle', 'auto.templates_more']) {
        expect(dict[key], `${locale}:${key}`).toBeTruthy();
      }
      for (const tpl of templates) {
        const fields = tpl.id === 'blank' ? ['name', 'desc'] : ['name', 'desc', 'seed', 'title'];
        for (const field of fields) {
          const key = `auto.tpl.${tpl.id}.${field}`;
          expect(dict[key], `${locale}:${key}`).toBeTruthy();
        }
      }
    }
  });
});
