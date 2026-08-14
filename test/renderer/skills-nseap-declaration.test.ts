/**
 * Security-panel rendering for the NSEAP declaration check.
 *
 * `_skillSecurityPanelText` is not exported and calls `t()`, so per project
 * convention it gets no CommonJS test bridge (that is reserved for pure
 * functions). These assertions read the source and the locale files instead.
 *
 * Weaker than driving the function, but they fail for the three things that would
 * actually reach a user:
 *   - a status rendered that must stay silent, or vice versa;
 *   - a locale key referenced in one language and missing in another, which shows
 *     the raw key name to that language's users;
 *   - threat vocabulary applied to what is only an authoring gap.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const PANEL_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'renderer', 'modules', 'skills.js'),
  'utf8',
);
const LOCALES = ['zh', 'en', 'ja', 'pt'] as const;

function loadLocale(name: string): Record<string, string> {
  return JSON.parse(
    fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'locales', `${name}.json`), 'utf8'),
  ) as Record<string, string>;
}

/** The declaration block, isolated so assertions cannot match neighbouring code. */
function nseapBlock(): string {
  const start = PANEL_SRC.indexOf('const nseap = sec.nseapDeclaration');
  expect(start).toBeGreaterThan(-1);
  const end = PANEL_SRC.indexOf('if (!sec.status ||', start);
  expect(end).toBeGreaterThan(start);
  return PANEL_SRC.slice(start, end);
}

describe('skills panel › nseap declaration', () => {
  /**
   * The one rendering decision with a real cost if reversed.
   *
   * No skill shipped today carries a security manifest, so every skill's check
   * returns `absent`. Rendering it would put a line on 100% of the library that
   * reads as a defect while describing one that does not exist — and a warning
   * that appears on everything is one users learn to skip, which is what makes
   * this a correctness issue rather than a matter of taste.
   */
  it('renders nothing for `absent` or `pass`', () => {
    const block = nseapBlock();
    expect(block).toContain("nseap.status !== 'absent'");
    expect(block).toContain("nseap.status !== 'pass'");
  });

  /**
   * `unavailable` means the engine could not run. It must not fall through to the
   * warning wording: reporting infrastructure failure as a finding about the
   * skill is the same class of error as rendering "not checked" as clean.
   */
  it('gives engine unavailability its own wording', () => {
    const block = nseapBlock();
    expect(block).toContain("nseap.status === 'unavailable'");
    expect(block).toContain('secpanel_nseap_unavailable');
  });

  /**
   * A declaration mismatch is an authoring defect. The engine calls it `blocked`
   * internally and the receipt layer already renames it to `mismatch`; this
   * asserts the renderer does not reintroduce threat vocabulary on the way out.
   */
  it('does not describe a declaration gap in threat terms', () => {
    const block = nseapBlock();
    expect(block).not.toMatch(/blocked|malicious|threat|dangerous/i);
    // And the user-facing note says which kind of problem this is.
    expect(block).toContain('secpanel_nseap_note');
  });

  it('caps the findings list and says how many were hidden', () => {
    const block = nseapBlock();
    // An engine run on a pathological tree can produce a long list; a panel that
    // printed all of them would bury everything above it.
    expect(block).toContain('.slice(0, 3)');
    expect(block).toContain('secpanel_nseap_more');
  });

  /**
   * Every key the block references must exist in all four languages. A key present
   * in only some shows its raw name — `skills.secpanel_nseap_mismatch` — to the
   * others, in the one panel where the user is trying to judge whether to trust
   * something.
   */
  it('defines every referenced key in all four locales', () => {
    const keys = [...new Set(
      Array.from(nseapBlock().matchAll(/t\('(skills\.secpanel_nseap[^']*)'\)/g))
        .map((m) => m[1]),
    )];
    expect(keys.length).toBeGreaterThan(0);

    for (const name of LOCALES) {
      const loc = loadLocale(name);
      for (const key of keys) {
        expect(loc[key], `${name}.json missing ${key}`).toBeTruthy();
      }
    }
  });

  /**
   * Placeholder parity: the count line is built by string replacement, so a
   * translation that dropped `{n}` would silently render "more not shown" with no
   * number rather than failing loudly.
   */
  it('keeps the {n} placeholder in every translation of the overflow line', () => {
    for (const name of LOCALES) {
      const loc = loadLocale(name);
      expect(loc['skills.secpanel_nseap_more'], `${name}.json`).toContain('{n}');
    }
  });
});
