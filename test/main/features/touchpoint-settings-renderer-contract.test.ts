import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('touchpoint settings renderer contract', () => {
  it('uses sibling overview and connection-management views instead of a stacked details panel', () => {
    const html = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/index.html'), 'utf8');
    expect(html).toContain('id="touchpoint-settings-page"');
    expect(html).toContain('id="touchpoint-connections-view"');
    expect(html).toContain('id="messaging-page"');
    expect(html).not.toContain('id="touchpoint-advanced"');
    expect(html).not.toContain('id="personal-context-page"');
  });

  it('routes management and Feishu connection actions through one connection view entry point', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/modules/touchpoint-settings.js'), 'utf8');
    expect(source).toContain('async function showConnections(options)');
    expect(source).toContain("if (action === 'connection.manage') { await showConnections(); return; }");
    expect(source).toContain("if (action === 'connection.connect') { await showConnections({ startFeishuQr: true }); return; }");
    expect(source).toContain("if (action === 'connections.back') { showOverview(); return; }");
  });

  it('talks to main through the canonical window.cogseed bridge, not the deprecated orkas alias', () => {
    // orkas 在上游 CogSeed 重构后只是兼容 Proxy 别名，经 contextBridge 暴露后
    // invoke/onPushEvent 不可用；触点页若回退到 orkas 会整页报"桌面端连接不可用"。
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/modules/touchpoint-settings.js'), 'utf8');
    expect(source).toContain('window.cogseed.invoke(channel, payload');
    expect(source).toContain('window.cogseed.onPushEvent');
    expect(source).not.toContain('window.orkas');
  });

  it('settings loads the unified touchpoint surface instead of both legacy centers', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/modules/settings.js'), 'utf8');
    expect(source).toContain('window.initTouchpointSettings');
    expect(source).not.toContain('window.initPersonalContextCenter');
    const messaging = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/modules/messaging-settings.js'), 'utf8');
    expect(messaging).toContain('window.openFeishuConnection');
    expect(fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/modules/touchpoint-settings-model.js'), 'utf8')).toContain("'connection.connect'");
  });

  it('feeds the touchpoint dashboard with live messaging status instead of the disk-normalized one', () => {
    // 磁盘持久化会把 connected/connecting 归一为 disconnected（连接是瞬时态，
    // 重启后不应信任旧状态）。触点 dashboard 必须走 manager.listInstances
    // （实时状态覆盖），否则机器人已连接时页面仍显示"未连接"。
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/main/features/personal_context/application/index.ts'), 'utf8');
    expect(source).toContain("import * as messagingManager from '../../messaging/manager'");
    expect(source).toContain('const instances = await messagingManager.listInstances(userId)');
    expect(source).not.toContain('messagingRegistry.listInstances(userId)');
  });

  it('guides the redirect-url setup right after QR binding instead of at authorization time', () => {
    // 飞书不允许程序化修改重定向 URL：扫码绑定成功后必须立即引导用户
    // 在开发者后台配置（复制地址 + 直达安全设置页），否则授权必报 20029。
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/modules/messaging-settings.js'), 'utf8');
    expect(source).toContain("invoke('personal_context.setup_guide', { instanceId })");
    expect(source).toContain('open.feishu.cn/app/');
    expect(source).toContain('auth.openExternal');
    expect(source).toContain('navigator.clipboard.writeText(guide.redirectUri)');
    expect(source).toContain("invoke('personal_context.setup_guide.confirm', {})");
    const ipc = fs.readFileSync(path.resolve(process.cwd(), 'src/main/ipc/personal-context.ts'), 'utf8');
    expect(ipc).toContain("'personal_context.setup_guide'");
    expect(ipc).toContain("'personal_context.setup_guide.confirm'");
    const manager = fs.readFileSync(path.resolve(process.cwd(), 'src/main/features/personal_context/manager.ts'), 'utf8');
    expect(manager).toContain('export async function getSetupGuide(uid: string, instanceId?: string)');
    expect(manager).toContain('export async function confirmRedirectConfigured(uid: string)');
  });

  it('blocks authorization until the redirect-url setup is confirmed', () => {
    // 未确认过回调地址配置时，触点页授权入口先展示引导卡（拦截授权发起），
    // 避免用户被晾在飞书 20029 错误页直到回调超时。
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/modules/touchpoint-settings.js'), 'utf8');
    expect(source).toContain("!guide.redirectConfigured");
    expect(source).toContain("throw new Error('setup_guide_pending')");
    expect(source).toContain("'setup_guide_pending'");
    expect(source).toContain("action === 'setup_guide.done'");
    expect(source).toContain("invoke('personal_context.setup_guide.confirm', {})");
    expect(source).toContain('renderSetupGuideCard()');
  });
});
