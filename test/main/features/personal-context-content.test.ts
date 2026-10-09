import { describe, expect, it } from 'vitest';
import { normalizeCalendarContent } from '../../../src/main/features/personal_context/feishu/content/calendar-handler';
import { normalizeDriveFileContent } from '../../../src/main/features/personal_context/feishu/content/drive-handler';
import { normalizeSheetContent } from '../../../src/main/features/personal_context/feishu/content/sheet-handler';
import { normalizeBitableContent } from '../../../src/main/features/personal_context/feishu/content/bitable-handler';
import { resolveContentHandler } from '../../../src/main/features/personal_context/feishu/content/handler';

describe('personal context content handlers', () => {
  it('normalizes calendar events with bounded evidence', () => {
    const result = normalizeCalendarContent({
      tenant: 'tenant-1',
      unionId: 'ou_user-1',
      calendarId: 'cal-1',
      event: {
        id: 'event-1',
        summary: '产品评审',
        startTime: '2026-08-11T09:00:00+08:00',
        endTime: '2026-08-11T10:00:00+08:00',
        description: '评审第一版方案',
      },
    });
    expect(result.resource.resourceType).toBe('calendar_event');
    expect(result.text).toContain('产品评审');
    expect(result.evidence[0]?.sourceResourceId).toBe(result.resource.resourceId);
    expect(result.resource.capability.canGenerateCandidates).toBe(true);
  });

  it('normalizes supported drive text content and rejects unsupported binaries as content', () => {
    const text = normalizeDriveFileContent({
      tenant: 'tenant-1',
      unionId: 'ou_user-1',
      file: { id: 'file-1', name: '计划.md', type: 'file', updatedAt: '2026-08-10T10:00:00Z', mimeType: 'text/markdown' },
      body: '# 计划\n\n完成 OAuth 验证',
    });
    expect(text.resource.resourceType).toBe('file');
    expect(text.text).toContain('完成 OAuth 验证');
    expect(text.resource.capability.canReadContent).toBe(true);

    const binary = normalizeDriveFileContent({
      tenant: 'tenant-1',
      unionId: 'ou_user-1',
      file: { id: 'file-2', name: '视频.mp4', type: 'file', updatedAt: '2026-08-10T10:00:00Z', mimeType: 'video/mp4' },
    });
    expect(binary.text).toBeUndefined();
    expect(binary.resource.capability.canReadContent).toBe(false);
    expect(binary.warnings[0]?.code).toBe('unsupported_content_type');
  });

  it('normalizes sheets and bitable records as structured content', () => {
    const sheet = normalizeSheetContent({
      tenant: 'tenant-1',
      unionId: 'ou_user-1',
      spreadsheetId: 'sheet-1',
      title: '课程表',
      sourceVersion: 'v2',
      rows: [['课程', '截止日期'], ['数据库', '2026-08-20']],
    });
    expect(sheet.structured).toEqual({ rows: [['课程', '截止日期'], ['数据库', '2026-08-20']] });
    expect(sheet.evidence).toHaveLength(2);

    const bitable = normalizeBitableContent({
      tenant: 'tenant-1',
      unionId: 'ou_user-1',
      appToken: 'app-1',
      tableId: 'table-1',
      title: '项目表',
      sourceVersion: 'v3',
      fields: [{ fieldId: 'name', name: '项目', type: 'text' }],
      records: [{ recordId: 'rec-1', fields: { name: '伴侣重构' } }],
    });
    expect(bitable.structured).toEqual({
      fields: [{ fieldId: 'name', name: '项目', type: 'text' }],
      records: [{ recordId: 'rec-1', fields: { name: '伴侣重构' } }],
    });
    expect(bitable.resource.capability.canGenerateCandidates).toBe(true);
  });

  it('resolves a handler for every supported content family', () => {
    expect(resolveContentHandler('calendar_event')).toBeTypeOf('function');
    expect(resolveContentHandler('file')).toBeTypeOf('function');
    expect(resolveContentHandler('document')).toBeTypeOf('function');
    expect(resolveContentHandler('folder')).toBeTypeOf('function');
  });
});
