import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const rendererRoot = path.resolve(__dirname, '../../src/renderer');
const source = fs.readFileSync(path.join(rendererRoot, 'modules/action-approval.js'), 'utf8');

describe('reception shell reason in the existing action approval dialog', () => {
  it('quality regression: keeps exact command whitespace and escapes shell markup in the existing preview', () => {
    let receive!: (info: unknown) => void;
    const modal = vi.fn((_options: { bodyHtml: string }) => Promise.resolve({ value: 'deny' }));
    const window = {
      t: (key: string) => key, uiModal: modal,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      cogseed: {
        onPushEvent: (_channel: string, listener: typeof receive) => { receive = listener; },
        invoke: vi.fn(async () => undefined),
      },
    };
    vm.runInNewContext(source, { window, document: { documentElement: { lang: 'en' } } });
    receive({ request_id: 'quality-exact', target_verbatim: true, target: '  echo <tag> # comment\nmkdir after-comment  ' });
    expect(modal.mock.calls[0][0].bodyHtml).toContain('<dd>  echo &lt;tag&gt; # comment\nmkdir after-comment  </dd>');
    expect(modal.mock.calls[0][0].bodyHtml).not.toContain('<tag>');
  });

  it.each(['en', 'zh', 'ja', 'pt'])('review regression: renders a translated reception reason in %s', (lang) => {
    const table = JSON.parse(fs.readFileSync(path.join(rendererRoot, 'locales', `${lang}.json`), 'utf8'));
    let receive!: (info: unknown) => void;
    const modal = vi.fn(() => Promise.resolve({ value: 'deny' }));
    const window = {
      t: (key: string) => table[key] ?? key,
      uiModal: modal,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      cogseed: {
        onPushEvent: (_channel: string, listener: typeof receive) => { receive = listener; },
        invoke: vi.fn(async () => undefined),
      },
    };
    vm.runInNewContext(source, { window, document: { documentElement: { lang } } });
    receive({ request_id: 'reception-shell', reasons: ['a2a_reception_shell'] });
    const html = (modal.mock.calls[0] as unknown as [{ bodyHtml: string }])[0].bodyHtml;
    expect(html).not.toContain('a2a_reception_shell');
    expect(table['action_approval.reason.a2a_reception_shell']).toBeTruthy();
    expect(html).toContain(table['action_approval.reason.a2a_reception_shell']);
  });
});
