import type { RuntimeHostToolName } from '../cogseed_runtime/protocol';
import type { MateHostToolResult, MateHostToolScope } from './office-adapter';
import { mateBrowserManager, type MateBrowserManager } from './browser-manager';

export function createMateBrowserAdapter(manager: MateBrowserManager = mateBrowserManager) {
  return {
    async run(name: Extract<RuntimeHostToolName, `browser_${string}`>, input: Record<string, unknown>, scope: MateHostToolScope, opts: { signal?: AbortSignal | null } = {}): Promise<MateHostToolResult> {
      if (name === 'browser_open') return manager.open(scope, typeof input.url === 'string' ? input.url : '', opts);
      if (name === 'browser_snapshot') return manager.snapshot(scope, typeof input.maxChars === 'number' ? input.maxChars : undefined);
      if (name === 'browser_click') return manager.click(scope, Number(input.ref));
      if (name === 'browser_type') return manager.type(scope, Number(input.ref), typeof input.text === 'string' ? input.text : '', input.submit === true);
      return manager.screenshot(scope, typeof input.path === 'string' ? input.path : undefined);
    },
  };
}
export const mateBrowserAdapter = createMateBrowserAdapter();
