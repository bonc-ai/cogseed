import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('touchpoint settings renderer contract', () => {
  it('uses one touchpoint page instead of stacking messaging and personal context centers', () => {
    const html = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/index.html'), 'utf8');
    expect(html).toContain('id="touchpoint-settings-page"');
    expect(html).toContain('id="messaging-page"');
    expect(html).not.toContain('id="personal-context-page"');
  });

  it('settings loads the unified touchpoint surface instead of both legacy centers', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/modules/settings.js'), 'utf8');
    expect(source).toContain('window.initTouchpointSettings');
    expect(source).not.toContain('window.initPersonalContextCenter');
    const messaging = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/modules/messaging-settings.js'), 'utf8');
    expect(messaging).toContain('window.openFeishuConnection');
    expect(fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/modules/touchpoint-settings-model.js'), 'utf8')).toContain("'connection.connect'");
  });
});
