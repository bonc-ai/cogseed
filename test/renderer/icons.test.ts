import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function loadIcons() {
  const context: any = {
    window: {},
    document: undefined,
  };
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/icons.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'icons.js' });
  return context.window;
}

describe('icons.js', () => {
  it('renders a real presentation icon instead of the info fallback', () => {
    const { uiIconHtml } = loadIcons();
    const html = uiIconHtml('presentation', 'oss-card-icon');
    expect(html).toContain('is-presentation');
    expect(html).toContain('M12 15v5');
    expect(html).not.toContain('M12 11v5');
  });

  it('renders the upload action instead of the info fallback', () => {
    const { uiIconHtml } = loadIcons();
    const upload = uiIconHtml('upload', 'kb-toolbar-icon');
    const info = uiIconHtml('info', 'kb-toolbar-icon');

    expect(upload).toContain('is-upload');
    expect(upload).toContain('M12 3v12');
    expect(upload).not.toBe(info);
  });

  it('renders both onboarding navigation arrows through the shared registry', () => {
    const { uiIconHtml } = loadIcons();
    const left = uiIconHtml('arrow-left', 'ui-button__icon');
    const right = uiIconHtml('arrow-right', 'ui-button__icon');

    expect(left).toContain('is-arrow-left');
    expect(left).toContain('M19 12H5');
    expect(right).toContain('is-arrow-right');
    expect(left).not.toBe(right);
  });

  it('renders the knowledge-workbench actions without falling back to info', () => {
    const { uiIconHtml } = loadIcons();
    const info = uiIconHtml('info', 'kb-mm-icon');

    for (const name of ['minus', 'download', 'history']) {
      const html = uiIconHtml(name, 'kb-mm-icon');
      expect(html).toContain(`is-${name}`);
      expect(html).not.toBe(info);
    }
  });

  it('routes Library file extensions to distinct SVG icon families', () => {
    const { fileKindForName, fileKindIconHtml } = loadIcons();

    expect(fileKindForName('report.pdf')).toBe('pdf');
    expect(fileKindForName('brief.docx')).toBe('doc');
    expect(fileKindForName('metrics.xlsx')).toBe('spreadsheet');
    expect(fileKindForName('launch.pptx')).toBe('presentation');
    expect(fileKindForName('photo.png')).toBe('image');
    expect(fileKindForName('demo.mp4')).toBe('video');
    expect(fileKindForName('worker.ts')).toBe('code');

    expect(fileKindIconHtml('metrics.xlsx')).toContain('is-spreadsheet');
    expect(fileKindIconHtml('launch.pptx')).toContain('is-presentation');
  });
});

describe('brand channel icons', () => {
  it('renders the supplied Feishu artwork and keeps the other channel marks vector based', () => {
    const { uiIconHtml } = loadIcons();
    const feishu = uiIconHtml('feishu', 'messaging-brand-glyph');
    expect(feishu).toContain('<img');
    expect(feishu).toContain('../resources/icons/feishu.png');
    expect(feishu).toContain('class="is-feishu"');

    for (const name of ['lark', 'wechat', 'wecom', 'telegram', 'qq', 'dingtalk', 'discord']) {
      const html = uiIconHtml(name, 'messaging-brand-glyph');
      expect(html).toContain(`is-${name}`);
      expect(html).toContain('<svg');
      expect(html).toContain('fill=');
      expect(html).not.toContain('stroke="currentColor"');
    }
  });

  it('keeps the Lark mark distinct and gives the WeCom artwork a non-cropping view box', () => {
    const { uiIconHtml } = loadIcons();
    const lark = uiIconHtml('lark', 'messaging-brand-glyph');
    const wecom = uiIconHtml('wecom', 'messaging-brand-glyph');

    expect(lark).not.toContain('./assets/messaging/feishu.png');
    expect(lark).toContain('viewBox="0 0 48 48"');
    expect(wecom).toContain('viewBox="-2 -2 38 38"');
    expect(wecom).not.toContain('viewBox="9 -3 27 35"');
  });

  it('keeps generic icons routing through the ui-icon wrapper', () => {
    const { uiIconHtml } = loadIcons();
    const html = uiIconHtml('qr-code', 'messaging-icon');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('is-qr-code');
  });
});
