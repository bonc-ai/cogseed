// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

/**
 * `uiIconHtml()` resolves an unknown name to the `info` glyph without warning,
 * so a markup reference to an icon nobody registered renders the wrong picture
 * and no test notices. The Run Center's sidebar button shipped that way. Pin
 * the static references in `index.html` against what the module actually
 * renders — the registry itself is module-private and stays that way.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function loadIcons(): (name: string, className?: string) => string {
  const context: any = { window: {}, Object, String, Array, Map, Set, JSON, Number };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(read('src/renderer/modules/icons.js'), context);
  const render = context.window.uiIconHtml;
  if (typeof render !== 'function') throw new Error('icons.js did not expose uiIconHtml');
  return render;
}

/** The wrapper carries `is-<name>`, so only the inner markup reveals a
 * fallback. Brand icons return their own complete element and are reported as
 * `null` — they are registered, just not through UI_ICONS. */
function innerMarkup(html: string): string | null {
  const match = /^<svg class="[^"]*" viewBox="0 0 24 24"[^>]*>([\s\S]*)<\/svg>$/.exec(html);
  return match ? match[1] : null;
}

function staticIconNames(): string[] {
  const html = read('src/renderer/index.html');
  const names = new Set<string>();
  // Skip template interpolation — only literal names are checkable here.
  for (const match of html.matchAll(/data-ui-icon="([^"${}]+)"/g)) names.add(match[1]);
  return [...names].sort();
}

describe('UI icon registry contract', () => {
  it('renders a distinct glyph for every icon the static markup asks for', () => {
    const uiIconHtml = loadIcons();
    const referenced = staticIconNames();
    const fallback = innerMarkup(uiIconHtml('info'));

    expect(referenced.length).toBeGreaterThan(0);
    expect(fallback).toBeTruthy();

    const fellBack = referenced.filter((name) => {
      if (name === 'info') return false;
      const inner = innerMarkup(uiIconHtml(name));
      return inner !== null && inner === fallback;
    });
    expect(fellBack).toEqual([]);
  });

  it('never renders an empty glyph for a referenced icon', () => {
    const uiIconHtml = loadIcons();
    const blank = staticIconNames().filter((name) => {
      const html = uiIconHtml(name);
      const inner = innerMarkup(html);
      return inner !== null ? !inner.trim() : !html.trim();
    });
    expect(blank).toEqual([]);
  });

  it('gives the Run Center sidebar entry its own glyph rather than the fallback', () => {
    const uiIconHtml = loadIcons();
    const html = read('src/renderer/index.html');

    expect(html).toMatch(/id="run-center-btn"[^>]*>\s*<span data-ui-icon="activity"/);
    expect(innerMarkup(uiIconHtml('activity'))).not.toBe(innerMarkup(uiIconHtml('info')));
  });

  it('detects a fallback, so the check cannot silently pass', () => {
    const uiIconHtml = loadIcons();
    // Guard against the assertions above going vacuous: an unregistered name
    // must be observable through exactly the comparison they rely on.
    expect(innerMarkup(uiIconHtml('definitely-not-registered'))).toBe(innerMarkup(uiIconHtml('info')));
  });
});
