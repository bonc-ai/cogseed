import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function loadFeatureLoader(onAppend?: (script: any, context: any) => void) {
  const appended: any[] = [];
  const context: any = {
    Map,
    Promise,
    Error,
    Object,
    String,
    window: {},
    document: {
      createElement: () => ({ dataset: {} }),
      head: {
        appendChild(script: any) {
          appended.push(script);
          if (onAppend) onAppend(script, context);
          else script.onload();
        },
      },
      documentElement: { appendChild() {} },
    },
  };
  context.window.window = context.window;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/lazy-features.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'lazy-features.js' });
  return { context, appended };
}

describe('renderer lazy feature loader', () => {
  it('loads the Settings bundle in declared classic-script order and shares concurrent work', async () => {
    const { context, appended } = loadFeatureLoader();

    const first = context.loadRendererFeature('settings');
    const second = context.loadRendererFeature('settings');
    expect(second).toBe(first);
    await first;

    expect(appended.map((script) => script.src)).toEqual([
      './modules/model-authorization.js',
      './modules/settings.js',
      './modules/hub-account.js',
      './vendor/qrcode-generator/qrcode.js',
      './modules/messaging-settings.js',
      './modules/touchpoint-settings-model.js',
      './modules/touchpoint-settings.js',
      './modules/memory.js',
      './modules/settings-security.js',
    ]);
    expect(appended.every((script) => script.async === false)).toBe(true);
  });

  it('does not fail marketplace loading when the optional dev enhancer is absent', async () => {
    const { context, appended } = loadFeatureLoader((script) => {
      if (script.src.endsWith('marketplace_dev.js')) script.onerror();
      else script.onload();
    });

    await expect(context.loadRendererFeature('marketplace')).resolves.toBeUndefined();
    expect(appended.map((script) => script.src)).toEqual([
      './modules/marketplace.js',
    ]);
  });

  it('loads public Agent and Skill surfaces without private publishing modules', async () => {
    const agents = loadFeatureLoader();
    await agents.context.loadRendererFeature('agents');
    expect(agents.appended.map((script) => script.src)).toEqual([]);

    const skills = loadFeatureLoader();
    await skills.context.loadRendererFeature('skills');
    expect(skills.appended.map((script) => script.src)).toEqual([
      './modules/recall-information-architecture.js',
      './modules/import-check-modal.js',
      './modules/skills.js',
      './modules/skills-bindings.js',
    ]);
  });

  it('keeps direct Agent and Skill entry working in the open-source build', async () => {
    const agents = loadFeatureLoader();
    await expect(agents.context.loadRendererFeature('agents')).resolves.toBeUndefined();

    const skills = loadFeatureLoader();
    await expect(skills.context.loadRendererFeature('skills')).resolves.toBeUndefined();
  });

  it('loads the workspace surface on demand and uses its lightweight resource catalog', async () => {
    // 9.1 重构：spaces surface 更名为 workspace（lazy-features manifest 用
    // workspace key + workspace.js；spaces.js 已废弃且无引用）。
    const { context, appended } = loadFeatureLoader();
    await context.loadRendererFeature('workspace');
    expect(appended.map((script) => script.src)).toEqual(['./modules/workspace.js']);

    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/workspace.js'), 'utf8');
    expect(source).toContain("_invoke('skills.list')");
    expect(source).toContain("_invoke('agents.list')");
    expect(source).toContain('renderWorkspace');
  });

  it('workspace surface：COGSEED-16 无确认态 + COGSEED-19 悬浮「+」新建任务入口', () => {
    const js = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/workspace.js'), 'utf8');
    // COGSEED-16：产物确认 UI 与通道全部移除（无按钮、无状态条、无 IPC 调用）
    expect(js).not.toContain('confirm-artifact');
    expect(js).not.toContain('reject-artifact');
    expect(js).not.toContain('spaces.artifacts.confirm');
    expect(js).not.toContain('spaces.artifacts.reject');
    expect(js).not.toContain('ws.candidate_pending');
    // COGSEED-19：空间卡片悬浮「+」直接新建该空间下任务（调用 _startNewTask，无二次弹窗）
    expect(js).toContain('data-ws="quick-task"');
    expect(js).toContain("_startNewTask(spaceId)");
    const css = fs.readFileSync(path.join(__dirname, '../../src/renderer/workspace.css'), 'utf8');
    expect(css).toContain('.ws-space-card:hover .ws-quick-task');
    // COGSEED-18：新建空间弹窗本地文件夹选择 + 导入进度订阅（workspace-import:progress 推送）
    expect(js).toContain('data-ws="pick-import-dir"');
    expect(js).toContain("_invoke('workspace.importFolder'");
    expect(js).toContain('workspace-import:progress');
  });

  it('retries a required script while reusing scripts that already loaded', async () => {
    let contextAttempts = 0;
    const { context, appended } = loadFeatureLoader((script) => {
      if (script.src.endsWith('contexts.js') && contextAttempts++ === 0) script.onerror();
      else script.onload();
    });

    await expect(context.loadRendererFeature('contexts')).rejects.toThrow('contexts.js');
    await expect(context.loadRendererFeature('contexts')).resolves.toBeUndefined();
    expect(appended.map((script) => script.src)).toEqual([
      './modules/library-transfer.js',
      './modules/contexts.js',
      './modules/contexts.js',
      './modules/kb-picker.js',
    ]);
  });

  it('keeps tab-only project, Library, apps, and devtools scripts out of the eager HTML', async () => {
    const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');
    for (const script of [
      'library-transfer.js',
      'project-detail.js',
      'contexts.js',
      'kb-picker.js',
      'skills.js',
      'auto.js',
    ]) {
      expect(html).not.toContain(`<script src="./modules/${script}"></script>`);
    }

    const { context, appended } = loadFeatureLoader();
    await context.loadRendererFeature('contexts');
    expect(appended.map((script) => script.src)).toEqual([
      './modules/library-transfer.js',
      './modules/contexts.js',
      './modules/kb-picker.js',
    ]);
  });

  it('removes the project feature entry after the space refactor', async () => {
    const { context } = loadFeatureLoader();
    await expect(context.loadRendererFeature('project')).rejects.toThrow('unknown renderer feature: project');
  });

  it('opens the recipient picker before loading tab-specific catalogs', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/agents.js'), 'utf8');
    const start = source.indexOf('async function _openAgentPicker');
    const end = source.indexOf('\nfunction _closeAgentPicker', start);
    const openBody = source.slice(start, end);
    const tabLoaderStart = source.indexOf('function _ensureAgentPickerTabData');
    const tabLoaderEnd = source.indexOf('\nfunction _moveAgentPickerTab', tabLoaderStart);
    const tabLoader = source.slice(tabLoaderStart, tabLoaderEnd);

    expect(openBody).toContain("_setAgentPickerTab('agents'");
    expect(openBody).toContain('_positionPopoverAboveOrBelow(picker, anchorBtn)');
    expect(openBody.indexOf('_refreshAgentPickerProjectContext(anchorBtn.id)')).toBeLessThan(
      openBody.indexOf("_setAgentPickerTab('agents'"),
    );
    expect(openBody).not.toContain("featureLoader('skills')");
    expect(openBody).not.toContain('loadSkills(true)');
    expect(openBody).not.toContain('loadConnectors()');
    expect(tabLoader).toContain("normalized === 'skills'");
    expect(tabLoader).toContain("await loader('skills')");
    expect(tabLoader).toContain('await loadSkills(false)');
    // 连接器 tab 已删：tab loader 不再加载 connectors 目录；产物/资产走渲染函数内懒加载
    expect(tabLoader).not.toContain("normalized === 'connectors'");
    expect(tabLoader).toContain("normalized === 'artifacts' || normalized === 'assets'");
    expect(tabLoader).toContain('const joined = existing.then');
    // 空间化后项目作用域已删：picker 恒为全局作用域，不应再引用 projects.scope。
    expect(source).not.toContain('projects.scope.resolve');
  });

  it('shows a retryable error instead of leaving a failed lazy view blank', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/boot.js'), 'utf8');
    const start = source.indexOf('function _loadViewFeature');
    const end = source.indexOf('\nfunction _restoreLastView', start);
    const lazyBoundary = source.slice(start, end);

    expect(lazyBoundary).toContain('_showLazyFeatureError(feature, view, err, run)');
    expect(lazyBoundary).toContain("banner.className = 'lazy-feature-error'");
    expect(lazyBoundary).toContain("t('chat.retry_btn')");
    expect(lazyBoundary).toContain('_loadViewFeature(feature, view, run)');
  });

  it('removes the project view branch after the space refactor', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/boot.js'), 'utf8');
    expect(source).not.toContain("} else if (view === 'project')");
    expect(source).not.toContain('primeProjectDetailShell');
  });

  it('upgrades the Agent startup summary once without force-refreshing every tab visit', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/boot.js'), 'utf8');
    const start = source.indexOf("} else if (view === 'agents')");
    const end = source.indexOf("} else if (view === 'skills')", start);
    const branch = source.slice(start, end);

    expect(branch).toContain("_loadViewFeature('agents', 'agents'");
    expect(branch.indexOf("_loadViewFeature('agents', 'agents'")).toBeLessThan(
      branch.indexOf('renderAgentsList(_agentsCache)'),
    );
    expect(branch).toContain('const needsFullListing');
    expect(branch).toContain('loadAgents(false)');
    expect(branch).not.toContain('loadAgents(forceRefresh)');
  });

  it('opens one Agent detail without refreshing the complete Agent list first', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/agents.js'), 'utf8');
    const start = source.indexOf('async function _showAgentsDetailView');
    const end = source.indexOf('async function refreshSelectedAgentDetail', start);
    const detailOpen = source.slice(start, end);

    expect(detailOpen).toContain('await selectAgent(agentId)');
    expect(detailOpen).not.toContain('loadAgents(true)');
  });

  it('does not probe local CLI runtimes until their selector is opened', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/local-agents.js'), 'utf8');

    expect(source).not.toContain('setTimeout(() => { loadLocalCliEntries');
    expect(source).toContain('async function mountExternalCliSelect');
    // 探测只在选择器打开时发生（loadExternalPanelData 封装了
    // detectAll + 托管网关状态 + 已绑定 CLI 标记，force: true 在打开时重扫）。
    expect(source).toContain('await loadExternalPanelData({ force: true });');
    expect(source).toContain('loadExternalPanelData');
  });

  it('keeps the scanning state visible by a minimum floor time', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/local-agents.js'), 'utf8');

    // 探测很快（本机 ~200ms）时「正在扫描本机 CLI…」会被 modal 动画吞掉，
    // 用户误以为没扫描：结果切换必须让出 EXT_CLI_SCAN_MIN_VISIBLE_MS 保底。
    expect(source).toContain('const EXT_CLI_SCAN_MIN_VISIBLE_MS = 300;');
    expect(source).toContain('const scanStartedAt = Date.now();');
    expect(source).toContain("if (scanElapsed < EXT_CLI_SCAN_MIN_VISIBLE_MS) {");
    expect(source).toContain('EXT_CLI_SCAN_MIN_VISIBLE_MS - scanElapsed');
  });

  it('re-probes local CLI runtimes when an Agent detail selector is rendered', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/agents.js'), 'utf8');
    const start = source.indexOf('async function _renderAgentDetailRuntime');
    const end = source.indexOf('async function _renderAgentDetailProjectDir', start);
    const runtimeSelector = source.slice(start, end);

    expect(runtimeSelector).toContain('loadLocalCliEntries({ force: true })');
    expect(runtimeSelector).toContain('const currentEntry = entries.find');
    expect(runtimeSelector).toContain('window.getLocalCliUnavailableHint(currentEntry)');
    expect(runtimeSelector).not.toContain("hint: t('agent.cli_missing')");
  });

  it('recovers the original task text from conversation history on slow-switch resend', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');

    // 快速失败切换：turn 已结束 / composer 已清空时，从历史回捞最近一条
    // 用户消息（含 @ 前缀），再重建为 `@新名 任务` 重新发送。
    expect(source).toContain('async function _fetchLatestUserTaskText(cid)');
    expect(source).toContain("gm.from === 'user'");
    expect(source).toContain('gm.dispatch !== true');
    expect(source).toContain('_historyRequestUrl(cid, null, 100)');
    expect(source).toContain('task = await _fetchLatestUserTaskText(cid)');
  });

});
