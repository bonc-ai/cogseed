/**
 * P3394 统一脱敏 fixture 测试（Conformance Matrix S-04 / M-06）。
 *
 * audit journal 与 transactional outbox 的脱敏统一到 logger 的 canonical
 * redact / log-sanitize：secret 命名键掩码 + 位置化 secret（Bearer、
 * key=value、JWT、provider token、邮箱、手机号、绝对路径）扫描。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-redaction-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('P3394 统一脱敏（S-04/M-06）', () => {
  it('audit journal 掩码任意深度的 secret 命名键并保留业务字段', async () => {
    const { P3394AuditJournal } = await import('../../../../src/main/features/p3394_bridge/audit-journal');
    const journal = new P3394AuditJournal();
    journal.append({
      event: 'bridge.send',
      actor_id: 'a',
      status: 'accepted',
      metadata: {
        token: 'raw-token',
        nested: { api_key: 'sk-raw', ok: true },
        list: [{ authorization: 'Bearer xyz' }, { message_id: 'm1' }],
        task_id: 'tsk-1',
      },
    });
    const metadata = journal.list()[0].metadata as Record<string, unknown>;
    expect(metadata.token).toBe('***REDACTED***');
    expect((metadata.nested as Record<string, unknown>).api_key).toBe('***REDACTED***');
    expect((metadata.nested as Record<string, unknown>).ok).toBe(true);
    expect((metadata.list as Array<Record<string, unknown>>)[0].authorization).toBe('***REDACTED***');
    expect((metadata.list as Array<Record<string, unknown>>)[1].message_id).toBe('m1');
    expect(metadata.task_id).toBe('tsk-1');
  });

  it('audit journal 保留顶层关联 id 的可追溯性（S-04/S-07 平衡）', async () => {
    const { P3394AuditJournal } = await import('../../../../src/main/features/p3394_bridge/audit-journal');
    const journal = new P3394AuditJournal();
    journal.append({
      event: 'control.cancel',
      actor_id: 'peer-a',
      status: 'accepted',
      metadata: {
        session_id: 'ses-cancel-1',
        task_id: 'tsk-cancel-1',
        message_id: 'msg-cancel-1',
        reply_to: 'msg-parent-1',
        token: 'raw-token',
      },
    });
    const metadata = journal.list()[0].metadata as Record<string, unknown>;
    expect(metadata.session_id).toBe('ses-cancel-1');
    expect(metadata.task_id).toBe('tsk-cancel-1');
    expect(metadata.message_id).toBe('msg-cancel-1');
    expect(metadata.reply_to).toBe('msg-parent-1');
    expect(metadata.token).toBe('***REDACTED***');
  });

  it('audit journal 扫描字符串值中的位置化 secret 与隐私数据', async () => {
    const { P3394AuditJournal } = await import('../../../../src/main/features/p3394_bridge/audit-journal');
    const journal = new P3394AuditJournal();
    journal.append({
      event: 'autoreply.send',
      actor_id: 'a',
      status: 'rejected',
      metadata: {
        endpoint: 'http://127.0.0.1:9999',
        error: 'call failed with Authorization: Bearer abcDEF1234567890 and access_token=qqq',
        contact: 'alice@example.com / 13800138000',
      },
    });
    const metadata = journal.list()[0].metadata as Record<string, unknown>;
    expect(metadata.endpoint).toBe('http://127.0.0.1:9999');
    const error = String(metadata.error);
    expect(error).toContain('Bearer ***');
    expect(error).not.toContain('abcDEF1234567890');
    expect(error).toContain('access_token=***');
    expect(error).not.toContain('=qqq');
    const contact = String(metadata.contact);
    expect(contact).toContain('a***@example.com');
    expect(contact).not.toContain('alice@');
    expect(contact).toContain('138****8000');
  });

  it('outbox failed 错误串落盘前脱敏且保留长度上限', async () => {
    const outbox = await import('../../../../src/main/features/p3394_bridge/outbound-outbox');
    outbox.outboxMarkFailed('msg-redact', 'dial failed token=secret123 Authorization: Bearer abcDEF1234567890');
    const lines = fs.readFileSync(outbox.outboxFilePath(), 'utf8').split('\n').filter(Boolean);
    const failed = JSON.parse(lines[lines.length - 1]) as { status: string; error: string };
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('token=***');
    expect(failed.error).toContain('Bearer ***');
    expect(failed.error).not.toContain('secret123');
    expect(failed.error).not.toContain('abcDEF1234567890');
    expect(failed.error.length).toBeLessThanOrEqual(300);
  });

  it('sanitizer fixtures: 保留不敏感形态，掩码敏感形态', async () => {
    const { sanitizeLogTextForUpload } = await import('../../../../src/main/util/log-sanitize');
    const keep = [
      `sha256:${'a'.repeat(64)}`,
      'msg-001 task tsk-002',
      'http://127.0.0.1:9999/p3394/inbound',
      'peer hermes alias Hermes',
    ];
    for (const text of keep) {
      expect(sanitizeLogTextForUpload(text)).toBe(text);
    }
    const mask: Array<[string, string]> = [
      ['Bearer abcDEF1234567890', 'Bearer ***'],
      ['token=secret123', 'token=***'],
      ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', '***JWT***'],
      ['sk-abcdefghijklmnopqrst', '***TOKEN***'],
      ['/Users/someone/private/file.txt', '<abs-path:'],
    ];
    for (const [input, expected] of mask) {
      const out = sanitizeLogTextForUpload(input);
      expect(out).toContain(expected);
      expect(out).not.toBe(input);
    }
  });
});
