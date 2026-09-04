// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import { classifyCogSeedFailure } from '../../../../src/main/features/cogseed_backend/ipc-service';

/**
 * `errorCode` is an open string space, so the value of this classifier is that
 * every code a real producer can emit lands in a category deliberately, and
 * anything else lands in `unknown` instead of being guessed. The producer
 * inventory below was taken from the code, not from a design document.
 */
describe('CogSeed failure classification', () => {
  const byCategory: Record<string, string[]> = {
    // kernel/model-adapter.ts:138 · model/core-agent/event-mapper.ts:78-86 ·
    // group_chat/plan_executor.ts:185
    model_unavailable: [
      'provider_auth', 'provider_not_configured', 'provider_balance',
      'provider_permission', 'model_preflight',
    ],
    provider_transient: [
      'provider_rate_limit', 'provider_server_error', 'provider_network',
      'provider_timeout', 'provider_no_first_event',
    ],
    provider_error: ['provider_error', 'provider_request', 'context_overflow'],
    // cogseed_runtime/kernel/execution-loop.ts:110,121 ·
    // runtime-controller.ts:177,665,680 · cogseed_runtime/index.ts:129
    runtime_failure: [
      'runtime_failed', 'runtime_tool_error', 'max_tool_rounds',
      'runtime_stream_ended', 'runtime_capture_failed', 'result_retention_failed',
    ],
    // runtime-controller.ts:444,587,681,1262 · recovery.ts:91 ·
    // cogseed_runtime/index.ts:181
    worker_restart: [
      'runtime_restart', 'worker_restart', 'runtime_watchdog_orphaned',
      'runtime_worker_error', 'runtime_worker_failed',
    ],
    conversation_unavailable: ['conversation_unavailable'],
    agent_unavailable: ['runtime_admission_failed'],
    collaboration_failure: ['group_chat_run_failed', 'group_chat_turn_failed'],
    // execution-loop.ts:47,85 · session-runner.ts:17 · bus.ts:3923
    cancelled: ['aborted', 'cancelled', 'group_chat_turn_cancelled'],
  };

  it('maps every verified producer code to its category', () => {
    for (const [category, codes] of Object.entries(byCategory)) {
      for (const code of codes) {
        expect(classifyCogSeedFailure(code), code).toBe(category);
      }
    }
  });

  it('assigns each code exactly one category', () => {
    const seen = new Map<string, string>();
    for (const [category, codes] of Object.entries(byCategory)) {
      for (const code of codes) {
        expect(seen.get(code), `${code} is claimed by two categories`).toBeUndefined();
        seen.set(code, category);
      }
    }
  });

  it('routes model-configuration failures away from retry', () => {
    // The R1 regression: an auth failure recommended "retry", which can never
    // succeed. These four all require the same user action — open model setup.
    for (const code of ['provider_auth', 'provider_not_configured', 'provider_balance', 'provider_permission']) {
      expect(classifyCogSeedFailure(code), code).toBe('model_unavailable');
    }
  });

  it('keeps unrecognised codes as unknown rather than guessing', () => {
    // local-cli-execution-adapter.ts:182 forwards the raw CLI status string,
    // which is not a failure taxonomy at all.
    expect(classifyCogSeedFailure('some_cli_status')).toBe('unknown');
    expect(classifyCogSeedFailure('provider')).toBe('unknown');
    expect(classifyCogSeedFailure('PROVIDER_AUTH')).toBe('unknown');
    expect(classifyCogSeedFailure('provider_auth_')).toBe('unknown');
  });

  it('returns no category when there is nothing to classify', () => {
    expect(classifyCogSeedFailure(undefined)).toBeUndefined();
    expect(classifyCogSeedFailure('')).toBeUndefined();
    expect(classifyCogSeedFailure('   ')).toBeUndefined();
  });

  it('lets settled Group Chat failure kinds win over the code map', () => {
    expect(classifyCogSeedFailure('anything', 'config')).toBe('model_unavailable');
    expect(classifyCogSeedFailure('anything', 'dependency')).toBe('collaboration_failure');
    expect(classifyCogSeedFailure('anything', 'operation')).toBe('collaboration_failure');
    expect(classifyCogSeedFailure('anything', 'runtime')).toBe('runtime_failure');
    expect(classifyCogSeedFailure('anything', 'validation')).toBe('unknown');
  });

  it('still resolves a model kind by its concrete code', () => {
    // plan_executor.ts:185 defaults a `model` kind to the retryable
    // `model_stream_error`, but a credential failure carries the same kind.
    // Trusting the kind here would send auth failures back to retry.
    expect(classifyCogSeedFailure('provider_auth', 'model')).toBe('model_unavailable');
    expect(classifyCogSeedFailure('provider_rate_limit', 'model')).toBe('provider_transient');
    expect(classifyCogSeedFailure('model_stream_error', 'model')).toBe('unknown');
  });

  it('classifies a kind-only failure that carries no code', () => {
    expect(classifyCogSeedFailure(undefined, 'config')).toBe('model_unavailable');
    expect(classifyCogSeedFailure(undefined, 'model')).toBe('unknown');
  });
});
