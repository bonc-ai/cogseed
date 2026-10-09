const RECOVERY_FAILURE_CODE_RE = /^[A-Za-z0-9._-]{1,96}$/;

function normalizeRecoveryFailureCode(failureCode: string | undefined): string | undefined {
  return typeof failureCode === 'string' && RECOVERY_FAILURE_CODE_RE.test(failureCode)
    ? failureCode
    : undefined;
}

export function buildRetryResumeModelText(input: {
  originalRequest: string;
  uncertainToolState: boolean;
  failureCode?: string;
}): string {
  const recoveryFailureCode = normalizeRecoveryFailureCode(input.failureCode);
  const rules = [
    '<task-retry mode="resume">',
    'Continue the unfinished task from the durable state in this same session.',
    'Read the authoritative execution plan, completed-work ledger, prior tool results, and history resources before acting.',
    'Do not repeat work already verified as successful.',
    input.uncertainToolState
      ? 'A tool started without a confirmed result. Verify its current state before deciding whether to run it again; never blindly repeat an external, paid, destructive, or otherwise non-idempotent operation.'
      : 'If an external, paid, destructive, or otherwise non-idempotent operation has an uncertain outcome, verify its current state before deciding whether to run it again.',
    'Respect every existing confirmation and permission gate. Complete the remaining work or report the smallest blocker that still requires the user.',
    ...(recoveryFailureCode ? [`Recovery reason: ${recoveryFailureCode}.`] : []),
    '</task-retry>',
    '',
    'Authoritative original request (quoted for objective continuity):',
    JSON.stringify(String(input.originalRequest || '')),
  ];
  return rules.join('\n');
}
