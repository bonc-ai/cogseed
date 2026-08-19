import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function loadLocale(name: string) {
  return JSON.parse(readFileSync(resolve(__dirname, `../../src/renderer/locales/${name}.json`), 'utf8'));
}

describe('agent activity locales', () => {
  it('defines the core Agent Activity labels in all renderer locales', () => {
    for (const locale of ['en', 'zh', 'ja', 'pt']) {
      const data = loadLocale(locale);
      expect(data['conversation_info.tab_agent_activity']).toBeTruthy();
      expect(data['conversation_info.agent_activity.loading']).toBeTruthy();
      expect(data['conversation_info.agent_activity.empty']).toBeTruthy();
      expect(data['conversation_info.agent_activity.state.running']).toBeTruthy();
      expect(data['conversation_info.agent_activity.dispatch_context']).toBeTruthy();
      expect(data['conversation_info.agent_activity.processing_trace']).toBeTruthy();
    }
  });
});
