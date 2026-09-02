// Unified execution entry — per-task execution config validation contract.
//
// The renderer's execution_config (model / reasoning-effort picks from the
// composer) is advisory at the business boundary: `_validatedExecutionConfig`
// shape-checks it, drops unknown enum values, keeps the CLI-agent
// model-only shape, and collapses all-empty objects to null. These tests pin
// that contract so a renderer regression can never push a malformed override
// into the turn pipeline (where it would either crash resolution or silently
// reroute a turn).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u-exec-cfg';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-exec-cfg-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function loadFacade() {
  return import('../../../../src/main/features/group_chat/index');
}

describe('group_chat › _validatedExecutionConfig (unified execution entry)', () => {
  it('keeps a full provider+model pair with effort', async () => {
    const facade = await loadFacade();
    expect(facade._validatedExecutionConfig({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      effort: 'high',
    })).toEqual({ provider: 'anthropic', model: 'claude-opus-4-8', effort: 'high' });
  });

  it('keeps a model-only override (CLI-agent shape) and drops a provider-only one', async () => {
    const facade = await loadFacade();
    expect(facade._validatedExecutionConfig({ model: 'claude-sonnet-4-6' }))
      .toEqual({ model: 'claude-sonnet-4-6' });
    // Provider without model is meaningless — collapses to null (unless an
    // effort rides along, which then survives on its own).
    expect(facade._validatedExecutionConfig({ provider: 'zai' })).toBeNull();
    expect(facade._validatedExecutionConfig({ provider: 'zai', effort: 'low' }))
      .toEqual({ effort: 'low' });
  });

  it('keeps a bare effort override', async () => {
    const facade = await loadFacade();
    expect(facade._validatedExecutionConfig({ effort: 'off' })).toEqual({ effort: 'off' });
  });

  it('drops unknown effort enum values', async () => {
    const facade = await loadFacade();
    // 'auto' never travels down this path (renderer omits the field); an
    // explicit 'auto' or garbage enum must not sneak through.
    expect(facade._validatedExecutionConfig({ effort: 'auto' })).toBeNull();
    expect(facade._validatedExecutionConfig({ effort: 'ultra' as any })).toBeNull();
  });

  it('collapses empty / non-object / blank-field payloads to null', async () => {
    const facade = await loadFacade();
    expect(facade._validatedExecutionConfig(null)).toBeNull();
    expect(facade._validatedExecutionConfig(undefined)).toBeNull();
    expect(facade._validatedExecutionConfig('model')).toBeNull();
    expect(facade._validatedExecutionConfig({})).toBeNull();
    expect(facade._validatedExecutionConfig({ provider: '  ', model: '  ' })).toBeNull();
  });

  it('trims whitespace around ids', async () => {
    const facade = await loadFacade();
    expect(facade._validatedExecutionConfig({ provider: ' zai ', model: ' glm-5 ' }))
      .toEqual({ provider: 'zai', model: 'glm-5' });
  });
});
