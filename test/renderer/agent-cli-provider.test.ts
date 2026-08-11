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

describe('CLI custom provider selector', () => {
  it('renders a provider selector and loads masked providers through IPC', () => {
    expect(html).toContain('id="agent-ext-provider-row"');
    expect(html).toContain('id="agent-modal-ext-provider-select"');
    expect(source).toContain("window.cogseed.invoke('customProviders.list')");
    expect(source).toContain('_renderExternalCliProviderSelect');
    expect(source).toContain('_getExternalCliProviderValue');
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
    expect(source).toContain('runtime: withCliProviderSelection');
  });
});
