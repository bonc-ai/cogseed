import { expect, it } from 'vitest';
import { getRuntimeToolCatalog } from '../../../../../src/main/features/mate_agent_runtime/kernel/tools/catalog';
it('exposes bounded Mate browser host tools', () => {
  expect(getRuntimeToolCatalog().filter((x) => x.name.startsWith('browser_')).map((x) => x.name)).toEqual(['browser_open', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_screenshot']);
});
