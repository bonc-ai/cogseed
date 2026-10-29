import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'src/renderer/modules/agents.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');

function loadAgentProviderHelpers() {
  const window: any = { addEventListener() {}, removeEventListener() {}, cogseed: { invoke() {} } };
  window.window = window;
  const context: any = {
    window, document: {}, createLogger: () => ({ warn() {}, error() {}, info() {} }),
    t: (key: string) => key, setTimeout, clearTimeout, console,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'agents.js' });
  return window;
}

describe('External agent creation (P3394 gateway)', () => {
  it('external agents join through the P3394 gateway, with an optional model provider row', () => {
    // P3394 外接方式：新建外接智能体走受管网关。2026-10-20 改版恢复「模型供应商」行：
    // p3394-wake-dispatcher 会把 runtime.cli_provider_id 传给网关，留空则用 CLI 自己的配置。
    expect(html).toContain('id="agent-ext-provider-row"');
    expect(html).toContain('id="agent-modal-ext-provider-select"');
    expect(source).toContain("window.cogseed.invoke('p3394.external.start'");
    expect(source).toContain("runtime: { kind: 'p3394-gateway', cli }");
    expect(source).toContain('body.runtime = withCliProviderSelection(body.runtime, _getExternalCliProviderValue(cli));');
  });

  it('filters Anthropic for Claude and OpenAI for Codex', () => {
    const api = loadAgentProviderHelpers();
    const providers = [
      { id: 'a', name: 'Anthropic relay', protocol: 'anthropic' },
      { id: 'o', name: 'OpenAI relay', protocol: 'openai' },
      { id: 'g', name: 'Gemini relay', protocol: 'gemini' },
    ];
    expect(api.filterCliProviders('claude', providers).map((p: any) => p.id)).toEqual(['a']);
    expect(api.filterCliProviders('codex', providers).map((p: any) => p.id)).toEqual(['o']);
  });

  it('clears incompatible bindings and persists cli_provider_id only when selected', () => {
    const api = loadAgentProviderHelpers();
    expect(api.normalizeCliProviderSelection('codex', 'cp:anthropic', [{ id: 'openai', protocol: 'openai' }])).toBe('');
    expect(api.normalizeCliProviderSelection('claude', 'cp:anthropic', [{ id: 'anthropic', protocol: 'anthropic' }])).toBe('cp:anthropic');
    const base = { kind: 'cli', cli: 'codex', model: 'gpt-5' };
    expect(api.withCliProviderSelection(base, 'cp:openai')).toEqual({ ...base, cli_provider_id: 'cp:openai' });
    expect(api.withCliProviderSelection({ ...base, cli_provider_id: 'cp:old' }, '')).toEqual(base);
    expect(source).toContain("runtime: { kind: 'p3394-gateway', cli }");
  });
});
