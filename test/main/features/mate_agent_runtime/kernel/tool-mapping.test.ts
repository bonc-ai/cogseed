import { describe, expect, it } from 'vitest';

import { TOOL_CATALOG as CORE_TOOL_CATALOG } from '../../../../../src/main/model/core-agent/tool-catalog';
import {
  CORE_TO_MATE_TOOL_MAPPINGS,
  MATE_NATIVE_RUNTIME_TOOL_NAMES,
  getExecutableMateToolNames,
  getCoreToMateToolMapping,
} from '../../../../../src/main/features/mate_agent_runtime/kernel/tools/core-tool-mapping';
import {
  getRuntimeOpenAIToolCatalog,
  getRuntimeToolCatalog,
} from '../../../../../src/main/features/mate_agent_runtime/kernel/tools/catalog';
import { RUNTIME_HOST_TOOL_NAMES } from '../../../../../src/main/features/mate_agent_runtime/protocol';

const CORE_NAMES = CORE_TOOL_CATALOG.map((entry) => entry.name);
const RUNTIME_NAMES = getRuntimeToolCatalog().map((entry) => entry.name);

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

describe('Core → Mate tool mapping', () => {
  it('covers every Core catalog entry exactly once', () => {
    expect(CORE_TO_MATE_TOOL_MAPPINGS.map((entry) => entry.coreName)).toEqual(CORE_NAMES);
    expect(new Set(CORE_TO_MATE_TOOL_MAPPINGS.map((entry) => entry.coreName)).size).toBe(CORE_NAMES.length);
  });

  it('classifies safe executable names and deferred tools without ambiguity', () => {
    const executable = new Set(getExecutableMateToolNames());
    expect(sorted(RUNTIME_NAMES)).toEqual(sorted([...executable, ...MATE_NATIVE_RUNTIME_TOOL_NAMES]));

    for (const entry of CORE_TO_MATE_TOOL_MAPPINGS) {
      if (entry.category === 'deferred') {
        expect(entry.mateNames).toEqual([]);
        expect(entry.reason.trim()).not.toBe('');
      } else {
        expect(entry.mateNames.length).toBeGreaterThan(0);
        expect(entry.reason.trim()).not.toBe('');
        for (const name of entry.mateNames) expect(executable.has(name)).toBe(true);
      }
    }
  });

  it('keeps connector actions behind the two umbrella tools', () => {
    expect(CORE_TO_MATE_TOOL_MAPPINGS.find((entry) => entry.coreName === 'list_connector_tools')).toMatchObject({
      category: 'parity',
      mateNames: ['list_connector_tools'],
    });
    expect(CORE_TO_MATE_TOOL_MAPPINGS.find((entry) => entry.coreName === 'call_connector_tool')).toMatchObject({
      category: 'parity',
      mateNames: ['call_connector_tool'],
    });
    expect(RUNTIME_NAMES.filter((name) => name.includes('connector')).sort()).toEqual([
      'call_connector_tool',
      'list_connector_tools',
    ]);
    expect(RUNTIME_NAMES.some((name) => name.includes('__'))).toBe(false);
  });

  it('does not expose a runtime tool without a Core mapping or explicit Mate-native declaration', () => {
    const mappedRuntimeNames = new Set(getExecutableMateToolNames());
    for (const name of RUNTIME_NAMES) {
      expect(mappedRuntimeNames.has(name) || MATE_NATIVE_RUNTIME_TOOL_NAMES.includes(name)).toBe(true);
    }
  });

  it('provides strict JSON schemas for every executable Runtime tool', () => {
    expect(getRuntimeOpenAIToolCatalog().map((tool) => tool.name)).toEqual(RUNTIME_NAMES);
    for (const tool of getRuntimeOpenAIToolCatalog()) {
      expect(tool.parameters).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });

  it('resolves individual mappings for compatibility consumers', () => {
    expect(getCoreToMateToolMapping('edit_office')).toMatchObject({
      category: 'mate-native-replacement',
      mateNames: ['office_edit'],
    });
    expect(getCoreToMateToolMapping('web_fetch')).toMatchObject({
      category: 'deferred',
    });
    expect(getCoreToMateToolMapping('unknown-tool')).toBeUndefined();
  });

  it('keeps the host protocol allow-list exact and finite', () => {
    expect(RUNTIME_HOST_TOOL_NAMES).toEqual([
      'office_read', 'office_create', 'office_edit', 'office_render',
      'browser_open', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_screenshot',
      'mate_delegate', 'mate_tasks', 'mate_cancel', 'mate_retry_step', 'mate_skip_step', 'mate_resume_workflow', 'mate_workflow',
    ]);
  });
});
