import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function loadMarkup(): Record<string, (...args: never[]) => string> {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/renderer/modules/expense-workbench-markup.js'), 'utf8');
  const context = {
    window: {} as Record<string, unknown>,
    t: (key: string) => key,
    uiIconHtml: (name: string) => `<i data-icon="${name}"></i>`,
  };
  vm.runInNewContext(source, context, { filename: 'expense-workbench-markup.js' });
  return context.window.expenseWorkbenchMarkup as Record<string, (...args: never[]) => string>;
}

describe('expense workbench renderer markup', () => {
  it('renders all seven sections with registered icons', () => {
    const markup = loadMarkup();
    const shell = markup.shell('Agent');
    for (const page of ['assistant', 'applications', 'precheck', 'overview', 'reviews', 'connections', 'audit']) {
      expect(shell).toContain(`data-ew-page="${page}"`);
    }
    expect(shell).toContain('data-icon="clipboard-list"');
    expect(shell).toContain('data-icon="layout-grid"');
  });

  it('escapes domain values before inserting them into generated markup', () => {
    const markup = loadMarkup();
    const html = markup.applications({
      applications: [],
      selectedApplication: {
        application: { application_id: '<private>', application_type: 'daily_expense', current_version: 1 },
        draft: { payload: {}, material_refs: [] },
      },
      message: '',
    } as never);
    expect(html).not.toContain('<private>');
    expect(html).toContain('&lt;private&gt;');
  });

  it('shows Feishu submission only for a ready, unsubmitted Feishu application', () => {
    const markup = loadMarkup();
    const ready = markup.applications({
      applications: [],
      selectedApplication: {
        application: {
          application_id: 'APP-1', current_version: 1, current_payload_hash: 'a'.repeat(64),
          precheck_status: 'ready_for_confirmation', oa_status: 'not_submitted',
          target: { environment: 'feishu', adapter: 'feishu-approval' },
        },
        draft: { payload: { expense_items: [{ amount: 1 }] }, material_refs: [] },
      },
      precheck: { status: 'ready' },
      message: '',
    } as never);
    expect(ready).toContain('data-ew-submit');

    const blocked = markup.applications({
      applications: [],
      selectedApplication: {
        application: {
          application_id: 'APP-1', current_version: 1, precheck_status: 'needs_review', oa_status: 'not_submitted',
          target: { environment: 'feishu', adapter: 'feishu-approval' },
        },
        draft: { payload: {}, material_refs: [] },
      },
      precheck: { status: 'needs_review' },
      message: '',
    } as never);
    expect(blocked).not.toContain('data-ew-submit');
  });

  it('renders sanitized Feishu preflight status and error codes', () => {
    const markup = loadMarkup();
    const html = markup.connections({
      settings: { configured: true },
      feishuPreflight: { status: 'preflight_failed', error_codes: ['approval_template_invalid<script>'] },
      message: '',
    } as never);
    expect(html).toContain('preflight_failed');
    expect(html).not.toContain('<script>');
    expect(html).toContain('打开本页只读取本地配置，不会联网');
    expect(html).toContain('允许访问飞书并检查连接');
  });

  it('renders a status refresh action only after Feishu creates an external instance', () => {
    const markup = loadMarkup();
    const html = markup.applications({
      applications: [],
      selectedApplication: {
        application: {
          application_id: 'APP-1', current_version: 1, current_payload_hash: 'a'.repeat(64),
          precheck_status: 'submitted', oa_status: 'submitted', external_application_id: 'instance-1',
          target: { environment: 'feishu', adapter: 'feishu-approval' },
        },
        draft: { payload: { expense_items: [{ amount: 1 }] }, material_refs: [] },
      },
      message: '',
    } as never);
    expect(html).toContain('data-ew-submit-status');
    expect(html).toContain('访问飞书 / OA');
  });

  it('shows recovery and Feishu retry only for their persisted failure states', () => {
    const markup = loadMarkup();
    const recovery = markup.applications({
      applications: [],
      selectedApplication: {
        application: {
          application_id: 'APP-RECOVER', current_version: 1,
          oa_status: 'submission_unknown', feishu_status: 'sync_failed',
        },
        draft: { payload: {}, material_refs: [] },
        feishu_outbox: { state: 'failed' },
      },
      message: '',
    } as never);
    expect(recovery).toContain('data-ew-recover-submission');
    expect(recovery).toContain('data-ew-retry-feishu');
    expect(recovery).toContain('二次确认');

    const healthy = markup.applications({
      applications: [],
      selectedApplication: {
        application: { application_id: 'APP-OK', current_version: 1, oa_status: 'not_submitted' },
        draft: { payload: {}, material_refs: [] },
      },
      message: '',
    } as never);
    expect(healthy).not.toContain('data-ew-recover-submission');
    expect(healthy).not.toContain('data-ew-retry-feishu');
  });
});
