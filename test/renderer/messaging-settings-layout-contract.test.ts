import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/renderer/modules/messaging-settings.js'),
  'utf8',
);
const rendererStyle = fs.readFileSync(
  path.resolve(process.cwd(), 'src/renderer/style.css'),
  'utf8',
);
const rendererHtml = fs.readFileSync(
  path.resolve(process.cwd(), 'src/renderer/index.html'),
  'utf8',
);

describe('messaging connection-management layout contract', () => {
  it('presents channel navigation and a focused connection overview', () => {
    expect(rendererSource).toContain("labelFor('messaging.catalog.page_title'");
    expect(rendererSource).toContain("labelFor('messaging.catalog.page_subtitle'");
    expect(rendererSource).toContain('messaging-channel-overview');
    expect(rendererSource).toContain('messaging-channel-summary');
    expect(rendererSource).toContain('messaging-channel-toggle');
  });

  it('groups instance, identity, behavior and danger controls by responsibility', () => {
    expect(rendererSource).toContain('messaging-section-heading');
    expect(rendererSource).toContain("'messaging.section.identity'");
    expect(rendererSource).toContain("'messaging.section.behavior'");
    expect(rendererSource).toContain("'messaging.section.danger'");
    expect(rendererSource).toContain('messaging-settings-section');
  });

  it('does not repeat the enable switch or bound association state inside instance rows', () => {
    const renderInstanceList = rendererSource.slice(
      rendererSource.indexOf('function renderInstanceList'),
      rendererSource.indexOf('function renderFeishuPanel'),
    );
    expect(renderInstanceList).not.toContain('switchControl(instance)');
    expect(rendererSource).toContain('if (!instance.hasCredentials) wrapper.appendChild(associationCard(instance));');
  });

  it('keeps additional bots behind an advanced action and excludes personal WeChat', () => {
    expect(rendererSource).toContain('messaging-instance-advanced');
    expect(rendererSource).toContain("labelFor('messaging.instance.advanced_summary'");
    expect(rendererSource).toContain("channel.platform !== 'wechat_personal'");
    expect(rendererSource).toContain("labelFor('messaging.instance.add_another'");
    const wechatAssociationCard = rendererSource.slice(
      rendererSource.indexOf('function wechatAssociationCard'),
      rendererSource.indexOf('function renderWechatPanel'),
    );
    expect(wechatAssociationCard).toContain("labelFor('messaging.instance.wechat_single_active'");
  });

  it('renders default and scene routing when a channel has multiple bots', () => {
    expect(rendererSource).toContain("invoke('touchpoints.config.get'");
    expect(rendererSource).toContain("invoke('touchpoints.config.save'");
    expect(rendererSource).toContain('messaging-routing-settings');
    expect(rendererSource).toContain("'task_approval'");
    expect(rendererSource).toContain("'daily_briefing'");
    expect(rendererSource).toContain("'external_send'");
    expect(rendererSource).toContain('proactiveTargetCount() < 2');
    expect(rendererSource).toContain("'messaging.routing.unresolved'");
    expect(rendererSource).toContain("'messaging.routing.invalid_instance'");
    expect(rendererSource).toContain("'messaging.routing.invalid_warning'");
    expect(rendererSource).toContain("'messaging.routing.feishu_scene_required'");
    expect(rendererSource).toContain("defaultInstance?.platform === 'wechat_personal'");
  });

  it('uses a responsive workbench rather than nested floating cards', () => {
    expect(rendererStyle).toContain('grid-template-columns: 210px minmax(0, 1fr);');
    expect(rendererStyle).toContain('.messaging-channel-overview {');
    expect(rendererStyle).toContain('.messaging-settings-section,');
    expect(rendererStyle).toContain('@media (max-width: 880px)');
    expect(rendererStyle).toContain('grid-template-columns: minmax(0, 1fr);');
  });

  it('keeps the connection page compact and removes the generic settings inset', () => {
    expect(rendererStyle).toContain('#panel-connections:has(.touchpoint-settings-shell.is-connections-view) .connections-container');
    expect(rendererStyle).toContain('.touchpoint-connections-header {');
    expect(rendererStyle).toMatch(/\.touchpoint-connections-header\s*\{[^{}]*display:\s*flex;[^{}]*min-height:\s*52px;/);
    expect(rendererStyle).toMatch(/\.touchpoint-connections-header h2\s*\{[^{}]*font-size:\s*16px;/);
    expect(rendererStyle).toMatch(/\.touchpoint-connections-view\s*\{[^{}]*gap:\s*8px;/);
    expect(rendererStyle).toMatch(/\.messaging-channel-overview\s*\{[^{}]*min-height:\s*82px;/);
  });

  it('uses a labelled left-facing back button instead of an icon fallback', () => {
    const header = rendererHtml.slice(
      rendererHtml.indexOf('<header class="touchpoint-connections-header">'),
      rendererHtml.indexOf('</header>', rendererHtml.indexOf('<header class="touchpoint-connections-header">')),
    );

    expect(header).toContain('class="btn touchpoint-back-button"');
    expect(header).toContain('data-ui-icon="chevron-left"');
    expect(header).toContain('data-i18n="common.back"');
    expect(header).not.toContain('data-ui-icon="arrow-left"');
  });

  it('edits the channel-bridge sender allowlist per instance', () => {
    // 每个渠道实例的设置面板有白名单卡：开关（关闭=显式清除 null）+ 名单编辑
    expect(rendererSource).toContain('function channelBridgeAllowlistCard');
    expect(rendererSource).toContain("settingsSection('messaging.section.bridge_allowlist'");
    expect(rendererSource).toContain('channelBridgeSenderAllowlist');
    // 四个渠道面板都插入白名单卡
    for (const panel of ['renderFeishuPanel', 'renderTelegramPanel', 'renderWecomPanel', 'renderWechatPanel']) {
      const body = rendererSource.slice(
        rendererSource.indexOf(`function ${panel}`),
        rendererSource.indexOf('function ', rendererSource.indexOf(`function ${panel}`) + 10),
      );
      expect(body).toContain('channelBridgeAllowlistCard(instance)');
    }
  });

  it('uses restrained neutral surfaces for navigation, the current account, and removal', () => {
    expect(rendererStyle).toMatch(/\.messaging-menu\s*\{[^{}]*background:\s*color-mix\(in srgb, var\(--surface\) 97%, var\(--text\) 3%\);/);
    expect(rendererStyle).toMatch(/\.messaging-menu-item\.is-active\s*\{[^{}]*background:\s*color-mix\(in srgb, var\(--primary\) 6%, var\(--surface\)\);/);
    expect(rendererStyle).toMatch(/\.messaging-primary-account\s*\{[^{}]*background:\s*color-mix\(in srgb, var\(--surface\) 98%, var\(--text\) 2%\);/);
    expect(rendererStyle).toContain('.messaging-delete-card { background: var(--surface); }');
    expect(rendererStyle).toContain('.messaging-menu-item-glyph > img,');
  });
});
