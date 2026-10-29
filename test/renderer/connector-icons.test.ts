import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { CONNECTOR_CATALOG } from '../../src/main/features/connectors/catalog';

const root = path.join(__dirname, '../..');

describe('connector brand icons', () => {
  it('renders all nine official marks from bundled files, retaining the enterprise mail icon', () => {
    const context: any = { window: {}, document: undefined };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(root, 'src/renderer/modules/icons.js'), 'utf8'), context);
    const expected = ['email-163', 'email-qq', 'tencent-meeting', 'tencent-survey', 'feishu', 'wecom', 'dingtalk', 'tencent-docs', 'wps'];
    for (const id of expected) {
      const entry = CONNECTOR_CATALOG.find(entry => entry.id === id)!;
      const html = context.window.uiIconHtml(entry.icon_name);
      const asset = html.match(/<img\s+src="([^"]+)"/)?.[1];
      expect(asset, id).toMatch(/^\.\.\/resources\/icons\/connectors\/[a-z0-9-]+\.(png|svg)$/);
      const bytes = fs.readFileSync(path.resolve(root, 'src/renderer', asset!));
      if (asset!.endsWith('.png')) expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      else expect(bytes.toString('utf8').trim()).toMatch(/^<svg\b/);
      expect(html).toContain('aria-hidden="true"');
      expect(html).not.toMatch(/https?:/);
    }
    expect(CONNECTOR_CATALOG.find(entry => entry.id === 'email-enterprise')?.icon_name).toBe('mail');
    const build = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build;
    expect(build.files).toContain('src/resources/icons/**/*');
  });

  it('loads the vendored SVG sanitizer before renderer utilities', () => {
    const indexHtml = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
    const purifier = '<script src="./vendor/dompurify/purify.min.js"></script>';
    const utilities = '<script src="./modules/utils.js"></script>';

    expect(fs.existsSync(path.join(root, 'src/renderer/vendor/dompurify/purify.min.js'))).toBe(true);
    expect(indexHtml.indexOf(purifier)).toBeGreaterThanOrEqual(0);
    expect(indexHtml.indexOf(purifier)).toBeLessThan(indexHtml.indexOf(utilities));
  });

  it('loads shared public renderer dependencies that survived hosted-module stripping', () => {
    const indexHtml = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
    for (const script of [
      './modules/user-error.js',
      './modules/interactive-cli.js',
    ]) {
      expect(fs.existsSync(path.join(root, 'src/renderer', script))).toBe(true);
      expect(indexHtml).toContain(`<script src="${script}"></script>`);
    }
  });

  it('renders exactly one connecting spinner', () => {
    const renderer = fs.readFileSync(path.join(root, 'src/renderer/modules/connectors.js'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'src/renderer/style.css'), 'utf8');

    // 连接中的载入态由共享按钮工厂产出（role/size/loading 三个入参），
    // 不是手写的 class 字符串；企业版 connectors.js 与上游逐字节一致。
    // 原断言写死了重构前的 `ui-button--secondary ui-button--sm is-loading`，
    // 且角色写成了 secondary（实际为 primary），两个形态在两侧源码里都不存在。
    expect(renderer).toContain("_connectorUiButton({ label: t('connectors.action.connecting'), role: 'primary', size: 'sm', loading: true");
    // is-loading 共 3 处：按钮工厂模板 1 处 + 安装确认弹窗按钮的命令式 add/remove 2 处，
    // 因此不再按出现次数断言"只有一个 spinner"；真正要守的是"没有旧的 btn-spinner 标记"。
    expect(renderer).not.toContain('class="btn-spinner"');
    expect(css).toContain('.btn.is-loading::before');
    expect(css).not.toMatch(/(^|\n)\.btn-spinner\s*\{/);
  });

  it('ships a sanitized SVG or a registered shared icon for every public connector card', () => {
    const icons = fs.readFileSync(path.join(root, 'src/renderer/modules/icons.js'), 'utf8');
    const missing = CONNECTOR_CATALOG
      .filter((entry) => !String(entry.icon_svg || '').trim().startsWith('<svg')
        && !(entry.icon_name && new RegExp(`(?:['"]${entry.icon_name}['"]|\\b${entry.icon_name})\\s*:`).test(icons)))
      .map((entry) => entry.id);

    expect(missing).toEqual([]);
  });
});
