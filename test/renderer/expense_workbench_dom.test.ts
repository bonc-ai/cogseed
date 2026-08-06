import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

type MarkupApi = {
  shell: (agentName: string) => string;
  unconfigured: () => string;
  applications: (state: Record<string, unknown>) => string;
};

function loadMarkup(): MarkupApi {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/renderer/modules/expense-workbench-markup.js'),
    'utf8',
  );
  const context = {
    window: {} as Record<string, unknown>,
    t: (key: string) => key,
    uiIconHtml: (name: string, className: string) => `<i class="${className}" data-icon="${name}"></i>`,
  };
  vm.runInNewContext(source, context, { filename: 'expense-workbench-markup.js' });
  return context.window.expenseWorkbenchMarkup as unknown as MarkupApi;
}

describe('expense workbench DOM contract', () => {
  it('keeps hidden status surfaces out of layout even when component styles set display', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'src/renderer/style.css'), 'utf8');

    expect(css).toMatch(/\.ew-config-banner\[hidden\][\s\S]*?display:\s*none/);
    expect(css).toMatch(/\.ew-error\[hidden\][\s\S]*?display:\s*none/);
    expect(css).toMatch(/\.ew-progress\[hidden\][\s\S]*?display:\s*none/);
  });

  it('keeps the shell keyboard- and screen-reader-addressable', () => {
    const html = loadMarkup().shell('Expense Agent');

    expect(html).toContain('aria-label="报销智能体"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('role="status"');
    expect(html).toContain('id="ew-main" tabindex="-1"');
    expect((html.match(/data-ew-page=/g) || []).length).toBe(7);
    expect((html.match(/aria-current="page"/g) || []).length).toBe(1);
  });

  it('provides a single-purpose first-use state without project actions', () => {
    const html = loadMarkup().unconfigured();

    expect(html).toContain('data-ew-unconfigured');
    expect((html.match(/data-ew-configure/g) || []).length).toBe(1);
    expect(html).not.toContain('data-ew-create');
    expect(html).not.toContain('data-ew-refresh');
  });

  it('escapes user values and exposes recovery controls as stable labelled actions', () => {
    const html = loadMarkup().applications({
      applications: [],
      selectedApplication: {
        application: {
          application_id: '<APP-1>',
          current_version: 3,
          current_payload_hash: 'a'.repeat(64),
          precheck_status: 'ready_for_confirmation',
          oa_status: 'submission_unknown',
          feishu_status: 'sync_failed',
          target: { environment: 'feishu', adapter: 'feishu-approval' },
        },
        draft: {
          payload: { expense_items: [{ amount: 10 }] },
          material_refs: [{ name: '<receipt>.pdf' }],
        },
        feishu_outbox: { state: 'failed' },
        feishu_notifications: [{ state: 'failed' }],
        approval: { can_decide: true, artifact_hash: 'b'.repeat(64), pending_roles: ['manager'] },
      },
      precheck: { status: 'ready' },
      message: '',
    });

    expect(html).toContain('data-ew-recover-submission');
    expect(html).toContain('data-ew-retry-feishu');
    expect(html).toContain('data-ew-retry-feishu-notifications');
    expect(html).toContain('data-ew-approve="approve"');
    expect(html).not.toContain('<APP-1>');
    expect(html).toContain('&lt;APP-1&gt;');
    expect(html).not.toContain('<receipt>.pdf');
    expect(html).toContain('&lt;receipt&gt;.pdf');
  });
});
