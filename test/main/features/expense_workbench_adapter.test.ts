import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { JsonObject } from '../../../../src/main/features/expense_workbench/contracts';

const startManagedStdioProcessMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/main/features/local_agents/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/features/local_agents/runner')>();
  return { ...actual, startManagedStdioProcess: startManagedStdioProcessMock };
});

let workspaceRoot: string;
let projectRoot: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  startManagedStdioProcessMock.mockReset();
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ew-data-'));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ew-project-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = workspaceRoot;
  fs.mkdirSync(path.join(projectRoot, '.venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.venv', 'bin', 'python3.12'), '#!/bin/sh\n');
  fs.chmodSync(path.join(projectRoot, '.venv', 'bin', 'python3.12'), 0o755);
  fs.symlinkSync('python3.12', path.join(projectRoot, '.venv', 'bin', 'python3'));
  fs.mkdirSync(path.join(projectRoot, 'src', 'expense_reimbursement', 'task_agent'), { recursive: true });
  const bridge = path.join(projectRoot, 'src', 'expense_reimbursement', 'task_agent', 'stdio_bridge.py');
  fs.writeFileSync(bridge, '# bridge\n');
  fs.writeFileSync(
    path.join(projectRoot, 'src', 'expense_reimbursement', 'task_agent', 'workbench_manifest.json'),
    JSON.stringify({
      schema_version: 1,
      component_id: 'expense-precheck',
      protocol_version: 1,
      entrypoint: 'expense_reimbursement.task_agent.stdio_bridge',
      bridge_sha256: crypto.createHash('sha256').update(fs.readFileSync(bridge)).digest('hex'),
    }),
  );
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('expense workbench adapter project validation', () => {
  it('isolates Python runtime data and host capabilities under the active Mate user', async () => {
    const paths = await import('../../../../src/main/paths');
    const { buildExpenseWorkbenchEnvironment } = await import('../../../../src/main/features/expense_workbench/adapter');
    const env = buildExpenseWorkbenchEnvironment(projectRoot, 'employee-1');

    expect(env.HOME).toBe(paths.userExpenseWorkbenchHomeDir('employee-1'));
    expect(env.USERPROFILE).toBe(paths.userExpenseWorkbenchHomeDir('employee-1'));
    expect(env.TMPDIR).toBe(paths.userExpenseWorkbenchTempDir('employee-1'));
    expect(env.TEMP).toBe(paths.userExpenseWorkbenchTempDir('employee-1'));
    expect(env.TMP).toBe(paths.userExpenseWorkbenchTempDir('employee-1'));
    expect(paths.userExpenseWorkbenchConfirmationsDir('employee-1')).toBe(path.join(
      env.HOME!,
      '.expense_reimbursement',
      'host-confirmations',
    ));
    expect(env).not.toHaveProperty('LLM_API_KEY');
    expect(env).not.toHaveProperty('FEISHU_APP_SECRET');
    expect(env.WORKBENCH_PRINCIPAL_ROLE).toBe('employee');
    expect(env).not.toHaveProperty('WORKBENCH_ROLES');
  });

  it('accepts a normal virtualenv launcher symlink', async () => {
    const { validateExpenseProjectRoot } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(validateExpenseProjectRoot(projectRoot)).toBe(fs.realpathSync(projectRoot));
  });

  it('rejects a bridge symlink that escapes the selected project', async () => {
    const external = path.join(workspaceRoot, 'outside-bridge.py');
    fs.writeFileSync(external, '# outside\n');
    const bridge = path.join(projectRoot, 'src', 'expense_reimbursement', 'task_agent', 'stdio_bridge.py');
    fs.unlinkSync(bridge);
    fs.symlinkSync(external, bridge);
    const { validateExpenseProjectRoot } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(() => validateExpenseProjectRoot(projectRoot)).toThrow('桥接文件');
  });

  it('rejects a project without the required interpreter', async () => {
    fs.rmSync(path.join(projectRoot, '.venv'), { recursive: true, force: true });
    const { validateExpenseProjectRoot } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(() => validateExpenseProjectRoot(projectRoot)).toThrow('Python 虚拟环境');
  });

  it('rejects a modified bridge whose digest no longer matches the component manifest', async () => {
    const bridge = path.join(projectRoot, 'src', 'expense_reimbursement', 'task_agent', 'stdio_bridge.py');
    fs.appendFileSync(bridge, '# unreviewed change\n');
    const { validateExpenseProjectRoot } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(() => validateExpenseProjectRoot(projectRoot)).toThrow('组件清单不匹配');
  });

  it('rejects a component manifest with unknown fields or a different identity', async () => {
    const manifest = path.join(projectRoot, 'src', 'expense_reimbursement', 'task_agent', 'workbench_manifest.json');
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    fs.writeFileSync(manifest, JSON.stringify({ ...parsed, component_id: 'other-component', extra: true }));
    const { validateExpenseProjectRoot } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(() => validateExpenseProjectRoot(projectRoot)).toThrow('组件身份不受支持');
  });

  it('persists configuration only after manifest, health, and identity handshakes succeed', async () => {
    const users = await import('../../../../src/main/features/users');
    const paths = await import('../../../../src/main/paths');
    users.activateUser('employee-1');
    const lineListeners: Array<(line: string) => void> = [];
    const writes: Array<Record<string, unknown>> = [];
    startManagedStdioProcessMock.mockReturnValue({
      pid: 123,
      onLine(listener: (line: string) => void) { lineListeners.push(listener); return () => undefined; },
      onStderr() { return () => undefined; },
      onExit() { return () => undefined; },
      async writeLine(line: string) {
        const request = JSON.parse(line) as Record<string, unknown>;
        writes.push(request);
        const operation = request.operation;
        const result = operation === 'manifest'
          ? { protocol_version: 1, component_id: 'expense-precheck', component_version: 'v1.3.0-rc1', operations: [
            'manifest', 'health.get', 'identity.get', 'overview.stats', 'applications.list', 'applications.get',
            'applications.create', 'applications.draft', 'applications.precheck', 'applications.confirm',
            'applications.report', 'materials.list', 'materials.add', 'materials.addAndBind', 'materials.delete',
            'reviews.list', 'audit.list', 'settings.get', 'settings.models', 'assistant.inspect', 'assistant.propose',
          ], data_scope: 'isolated_host_user' }
          : operation === 'health.get'
            ? { status: 'ready', component_version: 'v1.3.0-rc1', checks: { domain_store: 'ready', data_scope: 'isolated_host_user', external_connections: 'unconfigured' } }
            : { role: 'employee', capabilities: [
              'manifest', 'health.get', 'identity.get', 'overview.stats', 'applications.list', 'applications.get',
              'applications.create', 'applications.draft', 'applications.precheck', 'applications.confirm',
              'applications.report', 'materials.list', 'materials.add', 'materials.addAndBind', 'materials.delete',
              'reviews.list', 'audit.list', 'settings.get', 'settings.models', 'assistant.inspect', 'assistant.propose',
            ] };
        queueMicrotask(() => lineListeners[0](JSON.stringify({ request_id: request.request_id, ok: true, result })));
      },
      async close() {},
    });
    const agentId = 'c045605cb916';
    const agentDir = paths.userMarketplaceAgentDir('employee-1', agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'agent.json'), JSON.stringify({
      agent_id: agentId, name: 'Expense Workbench', description_zh: '', description_en: '', workflow: '',
      category: 'enterprise', source: 'marketplace', seed_source: 'builtin', management_surface: 'expense_workbench',
      interaction_mode: 'management_only', reimbursement_entry_role: 'canonical', enabled: true,
      created_at: '2026-08-03T00:00:00.000Z', updated_at: '2026-08-03T00:00:00.000Z',
    }));
    fs.writeFileSync(path.join(agentDir, '_install.json'), JSON.stringify({ seed_source: 'builtin' }));
    const { configureExpenseProject } = await import('../../../../src/main/features/expense_workbench/adapter');

    await configureExpenseProject('employee-1', projectRoot, agentId);

    expect(writes.map(({ operation }) => operation)).toEqual(['manifest', 'health.get', 'identity.get']);
    expect(JSON.parse(fs.readFileSync(paths.userExpenseWorkbenchConfigFile('employee-1'), 'utf8')))
      .toEqual({ version: 1, project_root: fs.realpathSync(projectRoot) });
  });
});

describe('expense workbench JSONL limits', () => {
  it('serializes ASCII and multibyte payloads using compact UTF-8 JSON', async () => {
    const { serializeExpenseWorkbenchRequest } = await import('../../../../src/main/features/expense_workbench/adapter');
    const request = serializeExpenseWorkbenchRequest(
      'request-1',
      'applications.draft',
      'employee-1',
      { ascii: 'receipt', chinese: '报销' },
    );

    expect(request).toBe('{"request_id":"request-1","operation":"applications.draft","user_id":"employee-1","payload":{"ascii":"receipt","chinese":"报销"}}');
    expect(Buffer.byteLength(request, 'utf8')).toBeGreaterThan(request.length);
  });

  it('accepts the exact 256 KiB payload boundary for ASCII and rejects one byte over', async () => {
    const {
      MAX_EXPENSE_WORKBENCH_PAYLOAD_BYTES,
      serializeExpenseWorkbenchRequest,
    } = await import('../../../../src/main/features/expense_workbench/adapter');
    const jsonOverhead = Buffer.byteLength('{"value":""}', 'utf8');
    const exactValue = 'a'.repeat(MAX_EXPENSE_WORKBENCH_PAYLOAD_BYTES - jsonOverhead);

    expect(() => serializeExpenseWorkbenchRequest(
      'request-2',
      'applications.draft',
      'employee-1',
      { value: exactValue },
    )).not.toThrow();
    expect(() => serializeExpenseWorkbenchRequest(
      'request-3',
      'applications.draft',
      'employee-1',
      { value: `${exactValue}a` },
    )).toThrow(`payload exceeds ${MAX_EXPENSE_WORKBENCH_PAYLOAD_BYTES} bytes`);
  });

  it('enforces the 256 KiB payload boundary by UTF-8 bytes', async () => {
    const {
      MAX_EXPENSE_WORKBENCH_PAYLOAD_BYTES,
      serializeExpenseWorkbenchRequest,
    } = await import('../../../../src/main/features/expense_workbench/adapter');
    const jsonOverhead = Buffer.byteLength('{"value":""}', 'utf8');
    const availableBytes = MAX_EXPENSE_WORKBENCH_PAYLOAD_BYTES - jsonOverhead;
    const exactValue = '报'.repeat(Math.floor(availableBytes / 3)) + 'a'.repeat(availableBytes % 3);

    expect(Buffer.byteLength(JSON.stringify({ value: exactValue }), 'utf8'))
      .toBe(MAX_EXPENSE_WORKBENCH_PAYLOAD_BYTES);
    expect(() => serializeExpenseWorkbenchRequest(
      'request-4',
      'applications.draft',
      'employee-1',
      { value: exactValue },
    )).not.toThrow();
    expect(() => serializeExpenseWorkbenchRequest(
      'request-5',
      'applications.draft',
      'employee-1',
      { value: `${exactValue}a` },
    )).toThrow(`payload exceeds ${MAX_EXPENSE_WORKBENCH_PAYLOAD_BYTES} bytes`);
  });

  it('accepts the exact 512 KiB JSONL boundary and rejects one byte over', async () => {
    const {
      MAX_EXPENSE_WORKBENCH_REQUEST_LINE_BYTES,
      serializeExpenseWorkbenchRequest,
    } = await import('../../../../src/main/features/expense_workbench/adapter');
    const emptyEnvelope = serializeExpenseWorkbenchRequest('', 'manifest', '', {});
    const exactRequestId = 'r'.repeat(
      MAX_EXPENSE_WORKBENCH_REQUEST_LINE_BYTES - Buffer.byteLength(emptyEnvelope, 'utf8'),
    );

    const exact = serializeExpenseWorkbenchRequest(exactRequestId, 'manifest', '', {});
    expect(Buffer.byteLength(exact, 'utf8')).toBe(MAX_EXPENSE_WORKBENCH_REQUEST_LINE_BYTES);
    expect(() => serializeExpenseWorkbenchRequest(`${exactRequestId}r`, 'manifest', '', {}))
      .toThrow(`request line exceeds ${MAX_EXPENSE_WORKBENCH_REQUEST_LINE_BYTES} bytes`);
  });

  it('rejects non-serializable payloads with contextual error chaining', async () => {
    const { serializeExpenseWorkbenchRequest } = await import('../../../../src/main/features/expense_workbench/adapter');
    const payload: JsonObject = {};
    payload.self = payload;

    let thrown: Error | undefined;
    try {
      serializeExpenseWorkbenchRequest('request-6', 'manifest', 'employee-1', payload);
    } catch (error) {
      thrown = error instanceof Error ? error : undefined;
    }
    expect(thrown?.message).toBe('expense bridge payload is not JSON serializable');
    expect(thrown?.cause).toBeInstanceOf(TypeError);
  });

  it('rejects oversized and non-serializable requests before starting the bridge process', async () => {
    const users = await import('../../../../src/main/features/users');
    const paths = await import('../../../../src/main/paths');
    users.activateUser('employee-1');
    const {
      MAX_EXPENSE_WORKBENCH_PAYLOAD_BYTES,
      callExpenseWorkbench,
    } = await import('../../../../src/main/features/expense_workbench/adapter');
    fs.mkdirSync(path.dirname(paths.userExpenseWorkbenchConfigFile('employee-1')), { recursive: true });
    fs.writeFileSync(paths.userExpenseWorkbenchConfigFile('employee-1'), JSON.stringify({
      version: 1,
      project_root: projectRoot,
    }));
    const agentId = 'c045605cb916';
    const agentDir = paths.userMarketplaceAgentDir('employee-1', agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'agent.json'), JSON.stringify({
      agent_id: agentId,
      name: 'Expense Workbench',
      description_zh: '',
      description_en: '',
      workflow: '',
      category: 'enterprise',
      source: 'marketplace',
      seed_source: 'builtin',
      management_surface: 'expense_workbench',
      interaction_mode: 'management_only',
      reimbursement_entry_role: 'canonical',
      created_at: '2026-08-03T00:00:00.000Z',
      updated_at: '2026-08-03T00:00:00.000Z',
    }));
    fs.writeFileSync(path.join(agentDir, '_install.json'), JSON.stringify({
      seed_source: 'builtin',
    }));

    await expect(callExpenseWorkbench(
      'employee-1',
      agentId,
      'applications.draft',
      { value: 'a'.repeat(MAX_EXPENSE_WORKBENCH_PAYLOAD_BYTES) },
    )).rejects.toThrow(`payload exceeds ${MAX_EXPENSE_WORKBENCH_PAYLOAD_BYTES} bytes`);

    const circularPayload: JsonObject = {};
    circularPayload.self = circularPayload;
    await expect(callExpenseWorkbench(
      'employee-1',
      agentId,
      'applications.draft',
      circularPayload,
    )).rejects.toThrow('expense bridge payload is not JSON serializable');
    expect(startManagedStdioProcessMock).not.toHaveBeenCalled();
  });
});

describe('expense workbench response boundary', () => {
  it('requires an exact success or failure envelope and bounded error fields', async () => {
    const { parseExpenseWorkbenchResponse } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(parseExpenseWorkbenchResponse(JSON.stringify({
      request_id: 'request-1', ok: true, result: {},
    }))).toEqual({ request_id: 'request-1', ok: true, result: {} });
    expect(parseExpenseWorkbenchResponse(JSON.stringify({
      request_id: 'request-2', ok: false,
      error: { code: 'E_INVALID_REQUEST', message: 'invalid', retryable: false },
    }))).toEqual({
      request_id: 'request-2', ok: false,
      error: { code: 'E_INVALID_REQUEST', message: 'invalid', retryable: false },
    });
    expect(parseExpenseWorkbenchResponse(JSON.stringify({
      request_id: 'request-python-1', ok: false,
      error: { code: 'internal_error', message: 'operation failed', retryable: true },
    }))).toEqual({
      request_id: 'request-python-1', ok: false,
      error: { code: 'internal_error', message: 'operation failed', retryable: true },
    });

    const invalidEnvelopes = [
      { request_id: 'request-3', ok: true, result: {}, error: { code: 'E_BAD', message: 'bad', retryable: false } },
      { request_id: 'request-4', ok: false, result: {}, error: { code: 'E_BAD', message: 'bad', retryable: false } },
      { request_id: 'request-5', ok: true, result: {}, extra: true },
      { request_id: 'request-6', ok: false, error: { code: 'bad-code', message: 'bad', retryable: false } },
      { request_id: 'request-7', ok: false, error: { code: 'E_BAD', message: 'x'.repeat(4_001), retryable: false } },
      { request_id: 'request-8', ok: false, error: { code: 'E_BAD', message: 'bad', retryable: false, extra: true } },
    ];
    for (const envelope of invalidEnvelopes) {
      expect(() => parseExpenseWorkbenchResponse(JSON.stringify(envelope))).toThrow();
    }
  });

  it('accepts only the operation-specific top-level response fields', async () => {
    const { validateExpenseWorkbenchResult } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(validateExpenseWorkbenchResult('overview.stats', {
      total_applications: 2,
      status_counts: { draft: 2 },
    })).toEqual({ total_applications: 2, status_counts: { draft: 2 } });
    expect(() => validateExpenseWorkbenchResult('overview.stats', {
      total_applications: 2,
      status_counts: {},
      ok: true,
    })).toThrow('schema');
  });

  it('accepts the live application projection fields used after external submission', async () => {
    const { validateExpenseWorkbenchResult } = await import('../../../../src/main/features/expense_workbench/adapter');
    const timestamp = '2026-08-04T00:00:00+00:00';
    expect(validateExpenseWorkbenchResult('applications.list', {
      applications: [{
        schema_version: 1,
        application_id: 'APP-1',
        application_type: 'daily_expense',
        application_type_label: '日常费用报销',
        status: 'submitted',
        current_version: 2,
        current_payload_hash: 'a'.repeat(64),
        external_application_id: 'instance-1',
        precheck_status: 'ready_for_confirmation',
        confirmation_status: 'confirmed',
        oa_status: 'submitted',
        feishu_status: 'synced',
        target: {
          system: 'oa', environment: 'feishu', adapter: 'feishu-approval',
          form_type: 'approval.v4', mapping_version: 'feishu-expense-v1',
        },
        submission_gate: { status: 'passed' },
        formal_report_gate: { status: 'passed' },
        created_at: timestamp,
        updated_at: timestamp,
      }],
    })).toMatchObject({ applications: [{ external_application_id: 'instance-1', oa_status: 'submitted' }] });
  });

  it('accepts Unicode approval roles and explicitly blocked formal reports', async () => {
    const { validateExpenseWorkbenchResult } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(validateExpenseWorkbenchResult('applications.approve', {
      approval_id: 'APR-1', application_id: 'APP-1', application_version: 1,
      approval_role: '直属经理', status: 'approved', decision: 'approve',
      acted_at: '2026-08-04T00:00:00+00:00', subject_hash: 'a'.repeat(64),
      artifact_hash: 'b'.repeat(64), bundle_hash: 'c'.repeat(64),
    })).toMatchObject({ approval_role: '直属经理', status: 'approved' });
    expect(validateExpenseWorkbenchResult('applications.report', {
      status: 'formal_report_blocked', application_id: 'APP-1', version: 1,
      report: { error_code: 'formal_report_blocked', message: 'approval.missing' },
    })).toMatchObject({ status: 'formal_report_blocked' });
  });

  it('rejects unknown and mistyped fields at nested operation-specific locations', async () => {
    const { validateExpenseWorkbenchResult } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(() => validateExpenseWorkbenchResult('materials.add', {
      material: {
        ref: `workspace://mat-${'a'.repeat(32)}`,
        name: 'receipt.pdf', media_type: 'application/pdf', size: '4', sha256: 'b'.repeat(64),
        material_category: 'expense_receipt', extra: true,
      },
    })).toThrow('schema');
  });

  it('rejects duplicate or excessive advertised capabilities and malformed timestamps', async () => {
    const { validateExpenseWorkbenchResult } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(() => validateExpenseWorkbenchResult('identity.get', {
      role: 'employee', capabilities: ['manifest', 'manifest'],
    })).toThrow('schema');
    expect(() => validateExpenseWorkbenchResult('identity.get', {
      role: 'employee', capabilities: Array.from({ length: 33 }, () => 'manifest'),
    })).toThrow('schema');
    expect(() => validateExpenseWorkbenchResult('audit.list', {
      total: 1,
      logs: [{ session_id: 'APP-1', action: 'created', created_at: '2026-08-03 00:00:00' }],
    })).toThrow('schema');
    expect(() => validateExpenseWorkbenchResult('reviews.list', {
      total: 1,
      reviews: [{
        task_id: 'hitl-20260803-aaaaaaaa', application_id: 'APP-1', status: 'approved',
        reviewed_at: '2026-08-03T00:00:00',
      }],
    })).toThrow('schema');
  });

  it.each([
    ['user_id', 'employee-1'],
    ['project_root', '/private/project'],
    ['data_base64', 'YWJj'],
    ['host_capability_id', 'hcap-secret'],
  ] as const)('rejects private nested field %s', async (field, value) => {
    const { validateExpenseWorkbenchResult } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(() => validateExpenseWorkbenchResult('applications.get', {
      application: { application_id: 'APP-1', [field]: value },
    })).toThrow('private');
  });

  it('rejects absolute path values even under an innocuous field name', async () => {
    const { validateExpenseWorkbenchResult } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(() => validateExpenseWorkbenchResult('assistant.inspect', {
      message: '/Users/example/private.pdf',
    })).toThrow('private path');
  });
});
