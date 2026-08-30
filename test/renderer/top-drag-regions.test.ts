import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/renderer/style.css'), 'utf8');

describe('macOS top drag regions', () => {
  it.each(['connections', 'workspace'])('covers the %s panel top edge', (panel) => {
    expect(html).toMatch(new RegExp(`id="panel-${panel}"[\\s\\S]*?class="app-top-drag-strip"`));
  });

  it('keeps Connections tabs and Workspace header controls above the drag strip', () => {
    expect(css).toMatch(/\.is-macos \.connections-tabs,[\s\S]*?\.is-macos \.ws-page-top\s*{[\s\S]*?z-index:\s*6;/);
    expect(css).toMatch(/\.is-macos \.ws-page-top button,[\s\S]*?\.is-macos \.connections-tabs button,[\s\S]*?-webkit-app-region:\s*no-drag;/);
    expect(css).toMatch(/\.is-macos \.ws-page-top button,[\s\S]*?\.is-macos \.ws-page-top input,[\s\S]*?-webkit-app-region:\s*no-drag;/);
  });
});
