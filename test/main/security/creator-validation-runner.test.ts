import { describe, expect, it, vi } from 'vitest';
import { runCreatorValidation } from '../../../src/main/security/creator-validation-runner';

describe('Creator validation runner', () => {
  it('redacts sensitive executor output before returning it', async () => {
    const values = [
      '/opt/private/validation-secret',
      'C:\\private\\validation-secret',
      'custom+scheme://private.internal/check',
      'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
      'line\u0000secret',
    ];
    const result = await runCreatorValidation('user-1', { checkId: 'test' }, {
      getActiveUserId: () => 'user-1',
      getWorkspacePath: () => process.cwd(),
      execute: vi.fn(async () => ({ exitCode: 1, stdout: values.join(' '), stderr: values.join(' ') })),
    });
    expect(result.status).toBe('failed');
    expect(result.output).toBe('[REDACTED]');
    for (const value of values) expect(JSON.stringify(result)).not.toContain(value);
  });

  it('redacts credentials, paths, and URLs inside structured JSON output', async () => {
    const secret = 'super-secret-value';
    const structured = JSON.stringify({
      password: secret,
      nested: { token: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890', path: '/private/check', url: 'ssh://private.invalid' },
    });
    const result = await runCreatorValidation('user-1', { checkId: 'test' }, {
      getActiveUserId: () => 'user-1',
      getWorkspacePath: () => process.cwd(),
      execute: vi.fn(async () => ({ exitCode: 1, stdout: structured, stderr: structured })),
    });
    expect(result.output).not.toContain(secret);
    expect(result.output).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz1234567890');
    expect(result.output).not.toContain('/private/check');
    expect(result.output).not.toContain('ssh://private.invalid');
  });

  it('redacts a password-only JSON payload without URL/path heuristics', async () => {
    const secret = 'super-secret-value';
    const result = await runCreatorValidation('user-1', { checkId: 'test' }, {
      getActiveUserId: () => 'user-1',
      getWorkspacePath: () => process.cwd(),
      execute: vi.fn(async () => ({
        exitCode: 1,
        stdout: JSON.stringify({ password: secret, ordinary: 'kept' }),
        stderr: '',
      })),
    });
    expect(result.output).not.toContain(secret);
    expect(result.output).toContain('ordinary');
  });

  it.each([
    ['null result', null],
    ['invalid exit code', { exitCode: '0', stdout: 'ok', stderr: '' }],
    ['invalid timeout flag', { exitCode: 0, timedOut: 'yes', stdout: 'ok', stderr: '' }],
    ['throwing result proxy', new Proxy({}, { get() { throw new Error('/private/executor token=secret'); } })],
  ])('fails closed for a malformed executor %s', async (_name, execution) => {
    const run = runCreatorValidation('user-1', { checkId: 'test' }, {
      getActiveUserId: () => 'user-1',
      getWorkspacePath: () => process.cwd(),
      execute: vi.fn(async () => execution as any),
    });

    if (_name === 'throwing result proxy') {
      await expect(run).rejects.toThrow('creator_validation_execution_failed');
      return;
    }
    const result = await run;

    expect(result).toMatchObject({
      check_id: 'test',
      status: 'failed',
      exit_code: null,
      output: 'creator_validation_execution_invalid',
    });
  });
});
