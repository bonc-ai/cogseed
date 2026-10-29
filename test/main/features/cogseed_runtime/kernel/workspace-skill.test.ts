import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runRuntimeSkillTool } from '../../../../../src/main/features/cogseed_runtime/kernel/tools/skill-tools';
import type { RuntimeToolCallContext } from '../../../../../src/main/features/cogseed_runtime/kernel/tools/file-tools';
import { listWorkspaceSkills } from '../../../../../src/main/features/skills';

let tmp: string;
let workspace: string;
let skillDir: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-ws-skill-')));
  workspace = path.join(tmp, 'workspace');
  skillDir = path.join(workspace, '.cogseed', 'skills', 'demo');
  fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: Workspace demo.\n---\n');
  fs.writeFileSync(path.join(skillDir, 'scripts', 'echo.sh'), '#!/bin/sh\nprintf "workspace-skill-ok"\n');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function context(): RuntimeToolCallContext {
  return {
    userId: 'u1',
    runtimeSessionId: 'mruntime-ws-skill',
    allowedRoots: [workspace],
    writableRoots: [workspace],
    workspaceRoot: workspace,
    pcDir: process.cwd(),
    // Host preflight is mandatory for runtime skill execution; ordinary runs
    // allow it without a reception approval.
    beforeAction: async () => undefined,
    allowedSkillIds: ['ws-demo'],
    toolPolicy: {
      fileRead: 'explicit_roots',
      fileWrite: 'explicit_writable_roots',
      shell: 'allow_with_confirmation',
      skillRun: 'allowlisted_skills',
      network: 'none',
      connectors: 'enabled',
    },
    actionApproval: {
      async request() { return { approved: true as const, requestId: 'approval-ws-skill' }; },
      async record() {},
    },
  };
}

describe('workspace-local skills', () => {
  it('discovers ws-prefixed skills under the workspace root', async () => {
    const skills = await listWorkspaceSkills(workspace);
    expect(skills).toEqual([
      expect.objectContaining({
        id: 'ws-demo',
        name: 'demo',
        workspaceRoot: workspace,
        source: 'custom',
      }),
    ]);
  });

  it('executes a workspace skill script through the trusted skill runner', async () => {
    const result = await runRuntimeSkillTool({ skill_id: 'ws-demo', script: 'echo' }, context(), {
      userId: 'u1',
      runtimeSessionId: 'mruntime-ws-skill',
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('workspace-skill-ok');
  });

  it('refuses a workspace skill not in the persisted allowlist', async () => {
    const result = await runRuntimeSkillTool({ skill_id: 'ws-demo', script: 'echo' }, {
      ...context(),
      allowedSkillIds: [],
    }, {
      userId: 'u1',
      runtimeSessionId: 'mruntime-ws-skill',
    });
    expect(result.isError).toBeTruthy();
    expect(result.content).toContain('E_RUNTIME_PERMISSION_DENIED');
  });
});
