import { describe, expect, it } from 'vitest';
import { loadCognitionAssets } from './helpers/cognition-renderer';

describe('夜间形成主线取代手动添加', () => {
  it('旧手动添加深链与后台重绘都不恢复表单，正式资产仍可查看', () => {
    const asset = { id: 'asset-1', type: 'personal', title: '可复用偏好', statement: '沟通先说结论。', status: 'active', version: '1' };
    const loaded = loadCognitionAssets({ assets: [asset] }, { name: 'overview', candCreate: '1' });
    for (let attempt = 0; attempt < 2; attempt++) {
      const html = loaded.render();
      expect(html).not.toContain('data-manual-candidate');
      expect(html).not.toContain('data-act="cand-create');
      expect(html).not.toContain('data-act="library-organize"');
      expect(html).toContain('可复用偏好');
    }
  });
  it('旧后台actions即使返回立即执行、重试、暂停恢复，也只显示来源回看', () => {
    const capture = { id: 'capture-old', conversationId: 'chat-origin', conversationTitle: '来源对话', status: 'failed', displayStatus: 'failed', stage: 'screening', actions: ['run_now', 'retry', 'pause', 'resume', 'cancel', 'configure_model'], reviewSummary: {} };
    const loaded = loadCognitionAssets({ captures: [capture] }, { name: 'activity', captureId: capture.id });
    const html = loaded.render();
    expect(html).toContain('data-act="open-conversation"');
    expect(html).not.toContain('data-act="capture-action"');
    expect(html).not.toContain('data-act="go-configure-model"');
  });
  it('实际夜间窗口如实展示，读取失败只显示状态', () => {
    const loaded = loadCognitionAssets({ captureSettings: { enabled: true, nightlyStart: '01:30', nightlyEnd: '04:45' }, captureModel: { channel: 'cli', available: true }, captureStatsError: 'offline' }, { name: 'settings' });
    const html = loaded.render();
    expect(html).toContain('01:30–04:45');
    expect(html).toContain('状态暂时无法读取');
    expect(html).not.toContain('data-act="refresh"');
    expect(html).toMatch(/aria-checked="false"[^>]*disabled[^>]*data-act="auto-approval-toggle"/);
  });

});
