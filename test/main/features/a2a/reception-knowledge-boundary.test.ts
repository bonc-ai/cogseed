import { describe, expect, it } from 'vitest';
import {
  getCoreToCogSeedToolMapping,
} from '../../../../src/main/features/cogseed_runtime/kernel/tools/core-tool-mapping';
import {
  A2A_RECEPTION_TOOL_POLICY,
  applyA2AReceptionScope,
} from '../../../../src/main/features/a2a/reception-scope';

/**
 * What a reception run may *know* (PRD D-18/D-22), pinned at the tool boundary.
 *
 * The reception ceiling in `reception-scope` covers files, shell, network and
 * connectors — it deliberately says nothing about knowledge, because knowledge
 * access is decided by the Core→Runtime tool mapping. That split is exactly why
 * this test exists: if someone later makes cross-session memory or chat history
 * executable, reception runs would silently gain access to the receiver's other
 * conversations, and this contract must fail first.
 */
describe('a2a reception › knowledge boundary (D-18/D-22)', () => {
  it('keeps personal assets readable through the KB replacements', () => {
    expect(getCoreToCogSeedToolMapping('kb_search')).toMatchObject({
      category: 'cogseed-native-replacement',
      cogseedNames: ['search_mate_kb'],
    });
    expect(getCoreToCogSeedToolMapping('kb_read')).toMatchObject({
      category: 'cogseed-native-replacement',
      cogseedNames: ['read_mate_kb'],
    });
  });

  it('never exposes cross-session memory or chat transcripts to a Runtime run', () => {
    for (const coreName of ['cross_session_memory', 'chat_search', 'chat_read']) {
      const mapping = getCoreToCogSeedToolMapping(coreName);
      expect(mapping, coreName).toBeTruthy();
      expect(mapping).toMatchObject({ category: 'deferred', cogseedNames: [] });
    }
  });

  it('leaves the knowledge boundary untouched by the reception ceiling', () => {
    // The ceiling is about execution, not knowledge: narrowing it must not be read
    // as "KB is closed", or a future fix would re-open it by loosening execution.
    expect(Object.keys(A2A_RECEPTION_TOOL_POLICY).sort()).toEqual([
      'connectors', 'fileRead', 'fileWrite', 'network', 'shell', 'skillRun',
    ]);
    expect(applyA2AReceptionScope(null)).not.toHaveProperty('kb');
  });
});
