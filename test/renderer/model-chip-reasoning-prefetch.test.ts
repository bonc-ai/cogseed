// Exec-config chip — reasoning capability prefetch.
//
// auth.listEntries carries no per-model reasoning annotation; the renderer
// capability table used to fill ONLY when the user drilled into a provider's
// model list, so a cold-opened top-level menu showed 「该模型不支持」 and
// disabled 低/高 for models the runtime actually forwards reasoning_effort
// for (main annotates from the same recognizer the runtime gating uses —
// the display contradicted the dispatch behavior). Pins the prefetch wiring
// as source contracts (DOM-free, same pattern as
// unified-execution-entry.test.ts).

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('exec-config chip — reasoning capability prefetch', () => {
  const chip = read('src/renderer/modules/model-chip.js');

  it('prefetches provider model annotations instead of waiting for the drill-in', () => {
    expect(chip).toContain('_prefetchReasoningForEntries');
    expect(chip).toContain("'auth.listModels'");
  });

  it('feeds the SAME capability table the drill-in uses (one source of truth)', () => {
    expect(chip).toContain('_modelReasoningByProvider.set(');
  });

  it('re-renders a cold-opened menu only when new annotations landed (no loop)', () => {
    // 仅在有新标注且菜单仍停在顶层执行配置视图时重画——防「重画→再预取→
    // 再重画」循环，也防把已下钻的二级列表拽回顶层。
    expect(chip).toMatch(/changed && menu\.isConnected && menu\.dataset\.view === 'exec'/);
  });

  it('warm-prefetches on entries load — boot path and entries-changed event', () => {
    // refreshModelChipEntries + cogseed:model-entries-changed + 菜单冷开
    // 三处都要触发预取。
    const calls = chip.match(/void _prefetchReasoningForEntries\(\)/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it('skips providers that already have a table (no refetch per menu open)', () => {
    expect(chip).toMatch(/_modelReasoningByProvider\.has\(provider\)/);
  });
});
