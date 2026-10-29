import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const rendererRoot = path.resolve(__dirname, '../../src/renderer');
/** 私仓维护的渲染层结构登记表；开源快照不导出 `docs/`。 */
const STRUCTURAL_REGISTRY = path.resolve(__dirname, '../../docs/renderer-structural-registry.md');

function loadStatusHint() {
  const source = fs.readFileSync(path.join(rendererRoot, 'modules/local-agents.js'), 'utf8');
  const calls: Array<{ key: string; vars?: Record<string, unknown> }> = [];
  const windowObject: Record<string, unknown> = {};
  const context = vm.createContext({
    window: windowObject,
    createLogger: () => ({ warn() {} }),
    t: (key: string, vars?: Record<string, unknown>) => {
      calls.push({ key, vars });
      return key;
    },
  });
  vm.runInContext(source, context, { filename: 'local-agents.js' });
  return {
    hint: windowObject.getLocalCliUnavailableHint as (entry: Record<string, unknown> | undefined) => string,
    externalTypes: windowObject.getExternalDefaultCliTypes as () => string[],
    calls,
  };
}

describe('external-agent unavailable status copy', () => {
  it('keeps registry failure reasons distinct', () => {
    const { hint, calls } = loadStatusHint();

    expect(hint({ error: 'not_found' })).toBe('agent.cli_not_found');
    expect(hint({ error: 'version_unknown' })).toBe('agent.cli_version_unknown');
    expect(hint({ error: 'version_too_old', version: '0.9.0' })).toBe('agent.cli_version_too_old');
    expect(calls.at(-1)).toEqual({
      key: 'agent.cli_version_too_old',
      vars: { version: '0.9.0' },
    });
  });

  it('exposes the stable external-agent product contract (six CLIs, incl. opencode)', () => {
    const { externalTypes } = loadStatusHint();
    expect(externalTypes()).toEqual(['claude', 'codex', 'openclaw', 'opencode', 'hermes', 'workbuddy']);
  });

  it('ships the three recovery messages in every renderer locale', () => {
    for (const locale of ['en', 'zh', 'ja', 'pt']) {
      const table = JSON.parse(fs.readFileSync(path.join(rendererRoot, `locales/${locale}.json`), 'utf8'));
      expect(table['agent.cli_not_found']).toBeTruthy();
      expect(table['agent.cli_version_unknown']).toBeTruthy();
      expect(table['agent.cli_version_too_old']).toContain('{version}');
      expect(table['agent_modal.ext_cli_scanning']).toBeTruthy();
      // 已接入标记（同 CLI 允许多实例，只打标不禁用；2026-10-20 改为卡片副标题）
      expect(table['agent_modal.ext_card_bound']).toContain('{n}');
    }
  });

  it('loads the bound-CLI marker with the external panel data', () => {
    const source = fs.readFileSync(path.join(rendererRoot, 'modules/local-agents.js'), 'utf8');
    expect(source).toContain('bound:');
    expect(source).toContain('res.bound');
    expect(source).toMatch(/agent_modal\.ext_card_bound/);
  });

  it('keeps the external-agent radio cards on one complete keyboard path', () => {
    const source = fs.readFileSync(path.join(rendererRoot, 'modules/local-agents.js'), 'utf8');

    expect(source).toContain('role="radio"');
    expect(source).toContain('aria-label="${escapeHtml(ariaLabel)}"');
    expect(source).toContain("card.type === focusableType ? '0' : '-1'");
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) {
      expect(source).toContain(`'${key}'`);
    }
    expect(source).toContain("if (e.key === 'Enter' || e.key === ' ')");
    expect(source).toContain('cardElement(card.type)?.focus()');
  });

  // `docs/` 是私仓文档目录，不随开源快照导出（`scripts/opensource/policy.json`
  // 的 `privatePaths` 里就有 `docs/`）。登记表是私仓的决策日志，文件不在时跳过
  // 这条登记检查；渲染层源码的键盘路径断言在上面，公仓照常运行。
  it.skipIf(!fs.existsSync(STRUCTURAL_REGISTRY))('registers the page-local radio cards in the structural registry', () => {
    const registry = fs.readFileSync(STRUCTURAL_REGISTRY, 'utf8');
    expect(registry).toContain('`local-agents.js`');
    expect(registry).toContain('roving tabindex');
  });
});
