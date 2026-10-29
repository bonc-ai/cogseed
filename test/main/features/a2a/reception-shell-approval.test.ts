import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/main/logger', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/main/logger')>(),
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

afterEach(() => vi.restoreAllMocks());

describe('reception shell action approval', () => {
  it.each([
    '/private/reception  workspace/with   spaces',
    `/private/${'long-directory/'.repeat(90)}exact-cwd-suffix`,
  ])('scope fidelity regression: SDK displays the exact working directory %#', async workingDir => {
    const fs = await import('node:fs');
    const paths = await import('../../../../src/main/paths');
    const i18n = await import('../../../../src/main/i18n');
    const approvals = await import('../../../../src/main/features/action_approval');
    const { requestReceptionShellApproval } = await import('../../../../src/main/features/a2a/reception-approval');
    const pushed: any[] = [];
    approvals._setActionApprovalBroadcastForTest((_channel, payload: any) => {
      pushed.push(payload);
      void approvals.respondActionApproval(payload.request_id, 'deny');
    });
    try {
      expect(await requestReceptionShellApproval({
        userId: 'reception-scope-user', requestId: 'scope-fidelity', runtimeSessionId: 'gchat:scope-fidelity',
        toolName: 'bash', command: 'pwd', workingDir,
      })).toBe('E_ACTION_APPROVAL_DENIED');
      expect(pushed).toHaveLength(1);
      expect(pushed[0].scope).toBe(i18n.t('a2a.reception.shell_scope', { workspace: workingDir }));
      expect(pushed[0].scope).toContain(workingDir);
      expect(fs.readFileSync(paths.actionApprovalAuditFile('reception-scope-user'), 'utf8')).not.toContain(workingDir);
    } finally {
      approvals._resetActionApprovalForTest();
      fs.rmSync(paths.userRoot('reception-scope-user'), { recursive: true, force: true });
    }
  });

  it.each([
    '  echo safe # comment\nmkdir hidden-after-comment  ',
    "cat <<'EOF'\nline  one\nEOF\nmkdir after-heredoc",
    `echo ${'x'.repeat(2100)}\nmkdir suffix-must-be-visible`,
  ])('quality regression: displays the full verbatim reception command %#', async command => {
    const fs = await import('node:fs');
    const paths = await import('../../../../src/main/paths');
    const approvals = await import('../../../../src/main/features/action_approval');
    const { requestReceptionShellApproval } = await import('../../../../src/main/features/a2a/reception-approval');
    const pushed: any[] = [];
    approvals._setActionApprovalBroadcastForTest((_channel, payload: any) => {
      pushed.push(payload);
      void approvals.respondActionApproval(payload.request_id, 'deny');
    });
    try {
      expect(await requestReceptionShellApproval({
        userId: 'reception-target-user', requestId: 'quality-target', runtimeSessionId: 'gchat:quality-target',
        toolName: 'bash', command, workingDir: '/private/exact-workspace',
      })).toBe('E_ACTION_APPROVAL_DENIED');
      expect(pushed).toHaveLength(1);
      expect(pushed[0]).toMatchObject({ target: command, target_verbatim: true });
      const audit = fs.readFileSync(paths.actionApprovalAuditFile('reception-target-user'), 'utf8');
      expect(audit).not.toContain(command);
      expect(audit).not.toContain('/private/exact-workspace');
    } finally {
      approvals._resetActionApprovalForTest();
      fs.rmSync(paths.userRoot('reception-target-user'), { recursive: true, force: true });
    }
  });

  it.each([
    ['en', 'A2A reception assistant', 'Run this command once in the reception workspace /private/workspace; valid only for this execution.'],
    ['zh', 'A2A 接待助理', '仅在接待工作区 /private/workspace 执行这一次命令，本次有效'],
    ['ja', 'A2A 受付アシスタント', '受付ワークスペース /private/workspace でこのコマンドを1回だけ実行します。この実行にのみ有効です。'],
    ['pt', 'Assistente de recepção A2A', 'Executar este comando uma vez no espaço de trabalho de recepção /private/workspace; válido apenas para esta execução.'],
  ] as const)('review regression: shell actor and scope use the selected %s UI language', async (lang, actor, scope) => {
    const i18n = await import('../../../../src/main/i18n');
    const previous = i18n.getCurrentUiLang();
    const { requestReceptionShellApproval } = await import('../../../../src/main/features/a2a/reception-approval');
    const request = vi.fn(async (_input: any) => ({ approved: true as const, requestId: 'localized-approval' }));
    try {
      i18n.setCurrentUiLang(lang);
      expect(await requestReceptionShellApproval({
        userId: 'receiver', requestId: 'turn-localized', runtimeSessionId: 'gchat:a2a-test',
        toolName: 'bash', command: 'mkdir example', workingDir: '/private/workspace',
      }, { request })).toMatchObject({ requestId: 'localized-approval', record: expect.any(Function) });
      expect(request).toHaveBeenCalledWith(expect.objectContaining({ actor, scope }));
    } finally {
      i18n.setCurrentUiLang(previous);
    }
  });

  it('fails closed for a known inbound origin when the conversation lookup fails, leaving local turns alone', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const lookup = vi.spyOn(chats, 'getConversation').mockRejectedValue(new Error('lookup unavailable'));
    const { receptionApprovalsForTurn } = await import('../../../../src/main/features/a2a/reception-approval');
    expect(await receptionApprovalsForTurn('receiver', 'a2a-cid', 'turn-local')).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
    await expect(receptionApprovalsForTurn('receiver', 'a2a-cid', 'turn-inbound', 'a2a_cs_peer')).rejects.toThrow('lookup unavailable');
  });

  it('binds each exact shell intent and keeps command/cwd out of audit summaries', async () => {
    const { requestReceptionShellApproval } = await import('../../../../src/main/features/a2a/reception-approval');
    const request = vi.fn(async (_input: any) => ({ approved: true as const, requestId: 'approval-1' }));
    const input = {
      userId: 'receiver', requestId: 'turn-1', runtimeSessionId: 'gchat:a2a-test',
      toolName: 'bash' as const, command: 'mkdir private-folder', workingDir: '/private/workspace',
      signal: new AbortController().signal,
    };
    expect(await requestReceptionShellApproval(input, { request })).toMatchObject({ requestId: 'approval-1', record: expect.any(Function) });
    expect(await requestReceptionShellApproval({ ...input, command: 'mkdir other-folder' }, { request })).toMatchObject({ requestId: 'approval-1', record: expect.any(Function) });
    expect(request).toHaveBeenCalledTimes(2);
    const first = request.mock.calls[0][0];
    expect(first).toMatchObject({
      userId: 'receiver', runtimeRequestId: 'turn-1', runtimeSessionId: 'gchat:a2a-test',
      action: 'bash', risk: 'high', reasons: ['a2a_reception_shell'], target: input.command, signal: input.signal,
      auditTarget: 'Reception shell command', auditScope: 'tool: bash',
    });
    expect(first.scope).toContain(input.workingDir);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(request.mock.calls[1][0].fingerprint).not.toBe(first.fingerprint);
  });

  it.each(['E_ACTION_APPROVAL_DENIED', 'E_ACTION_APPROVAL_CANCELLED', 'E_ACTION_APPROVAL_EXPIRED', 'E_ACTION_APPROVAL_UNAVAILABLE'] as const)(
    'returns %s without approval', async (code) => {
      const { requestReceptionShellApproval } = await import('../../../../src/main/features/a2a/reception-approval');
      expect(await requestReceptionShellApproval({
        userId: 'receiver', requestId: 'turn-1', runtimeSessionId: 'gchat:a2a-test',
        toolName: 'bash', command: 'mkdir denied', workingDir: '/private/workspace',
      }, { request: async () => ({ approved: false, code }) })).toBe(code);
    },
  );
});
