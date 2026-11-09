import { describe, expect, it } from 'vitest';
import { TOOL_CATALOG } from '../../src/main/features/cogseed_runtime/kernel/tools/catalog';
import {
  COGSEED_NATIVE_RUNTIME_TOOL_NAMES,
  getExecutableCogSeedToolNames,
} from '../../src/main/features/cogseed_runtime/kernel/tools/core-tool-mapping';
import { isParallelSafeRuntimeTool } from '../../src/main/features/cogseed_runtime/kernel/execution-loop';
import { ontologyActionCapability } from '../../src/main/features/cognition/ontology/ontology-action-capabilities';

describe('runtime tool registration', () => {
  it('maps every executable catalog tool to a Core alias or the native list', () => {
    const registered = new Set([
      ...getExecutableCogSeedToolNames(),
      ...COGSEED_NATIVE_RUNTIME_TOOL_NAMES,
    ]);
    for (const tool of TOOL_CATALOG) {
      expect(registered.has(tool.name), tool.name).toBe(true);
    }
  });

  it('keeps the cognition query host tools registered as native tools', () => {
    expect(COGSEED_NATIVE_RUNTIME_TOOL_NAMES).toEqual(expect.arrayContaining([
      'ontology_task_query',
      'search_ability_assets',
    ]));
  });

  it('does not mark receipt-writing host tools as parallel-safe', () => {
    expect(isParallelSafeRuntimeTool('ontology_task_query')).toBe(false);
    expect(isParallelSafeRuntimeTool('search_ability_assets')).toBe(false);
  });

  it('treats the legacy graph read as read-only effect coverage', () => {
    expect(ontologyActionCapability('ontology_graph_read', {}).coverage).toBe('read_only');
  });
});
