import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadCognitionAssets } from './helpers/cognition-renderer';

describe('旧记忆迁移用户入口退休', () => {
  it('旧数据和异常状态不能重新开启迁移页面，也不发起预览或迁移请求', async () => {
    const invoke = vi.fn(async () => ({}));
    const f = loadCognitionAssets({ legacyMemoryMigration: { failed: true, preview: { items: [{ text: '旧记忆正文' }] } }, legacyScopedMemoryMigration: { failed: true } }, { name: 'settings' }, { cogseed: { invoke } });
    const html = f.render();
    for (const entry of ['旧记忆正文', 'legacy-memory-run', 'legacy-memory-refresh', 'legacy-scoped-memory-run']) expect(html).not.toContain(entry);
    expect(invoke).not.toHaveBeenCalled();
    for (const file of ['views.js', 'core.js', 'app.js']) {
      const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/cognition-assets', file), 'utf8');
      expect(source).not.toContain('legacyMemoryMigrationSection');
      expect(source).not.toContain('legacyScopedMemoryMigrationSection');
      expect(source).not.toContain('legacyMemoryMigration.run');
    }
  });
});
