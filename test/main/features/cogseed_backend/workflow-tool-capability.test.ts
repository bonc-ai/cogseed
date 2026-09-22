import * as fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as paths from '../../../../src/main/paths';
import { createCogSeedCoordinator } from '../../../../src/main/features/cogseed_backend/coordinator';
import { resolveRuntimeCapabilities } from '../../../../src/main/features/cogseed_backend/messaging-capability-policy';
import { getOrCreateCogSeedCommanderSession } from '../../../../src/main/features/cogseed_backend/session-store';
import { createCogSeedTask } from '../../../../src/main/features/cogseed_backend/task-store';
import {
  filterRuntimeToolCatalogByCapabilities,
  getRuntimeToolCatalog,
} from '../../../../src/main/features/cogseed_runtime/kernel/tools/catalog';

const UID = 'cogseed-workflow-capability-user';
const CONVERSATION = 'conversation-workflow';
const WORKFLOW_TOOLS = [
  'cogseed_workflow',
  'cogseed_retry_step',
  'cogseed_skip_step',
  'cogseed_resume_workflow',
];

afterEach(() => fs.rmSync(paths.userRoot(UID), { recursive: true, force: true }));

function coordinator() {
  return createCogSeedCoordinator({
    startTask: vi.fn(async (userId: string, input: any) => (await createCogSeedTask(userId, input)).task),
    cancelTask: vi.fn(async () => {
      throw new Error('unexpected cancel');
    }),
  });
}

async function commanderTask(requestId: string) {
  const session = await getOrCreateCogSeedCommanderSession(UID, CONVERSATION);
  const record = (await createCogSeedTask(UID, {
    requestId,
    task: 'Coordinate the release plan',
    sessionId: session.sessionId,
  })).task;
  return record;
}

function catalogNames(capabilities: readonly string[]): string[] {
  return filterRuntimeToolCatalogByCapabilities(getRuntimeToolCatalog(), capabilities).map((entry) => entry.name);
}

describe('CogSeed workflow host-tool capability', () => {
  it('hides the workflow tools from a task that has no coordination workflow', async () => {
    const record = await commanderTask('req-no-workflow');
    const capabilities = await resolveRuntimeCapabilities(UID, record.requestId, record.runtimeSessionId);

    expect(capabilities).not.toContain('cogseed.workflow');
    // The Commander-only gates are unchanged by this grant.
    expect(capabilities).toEqual(expect.arrayContaining(['messaging.proactive', 'p3394.interop']));
    const names = catalogNames(capabilities);
    for (const tool of WORKFLOW_TOOLS) expect(names).not.toContain(tool);
    expect(names).toContain('cogseed_delegate');
  });

  it('grants the workflow tools to the task that owns a coordination run', async () => {
    const record = await commanderTask('req-workflow-owner');
    await coordinator().delegate(UID, record.requestId, { requestId: 'req-workflow-child', task: 'Research' });

    const capabilities = await resolveRuntimeCapabilities(UID, record.requestId, record.runtimeSessionId);
    expect(capabilities).toContain('cogseed.workflow');
    const names = catalogNames(capabilities);
    for (const tool of WORKFLOW_TOOLS) expect(names).toContain(tool);
  });

  it('does not grant the workflow tools to a delegated child of the coordination', async () => {
    const record = await commanderTask('req-workflow-parent');
    const child = await coordinator().delegate(UID, record.requestId, { requestId: 'req-workflow-member', task: 'Research' });

    // A child carries the parent's coordinationId, but the host router derives the
    // coordination from the calling task id, so the child cannot drive that run.
    const capabilities = await resolveRuntimeCapabilities(UID, child.requestId, child.runtimeSessionId);
    expect(capabilities).not.toContain('cogseed.workflow');
    const names = catalogNames(capabilities);
    for (const tool of WORKFLOW_TOOLS) expect(names).not.toContain(tool);
  });
});
