import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let root: string; let previous: string | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-kstar-trace-')); previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root; });
afterEach(() => { if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); });

it('returns a sanitized trace for a conversation and distinguishes skipped forecast', async () => {
  const store = await import('../../../../src/main/features/kstar/requirement-store');
  const task = store.createKstarTaskRecord('user-a', { conversationId: 'cid-trace', title: 'Trace task' });
  const requirement = store.createKstarRequirementRecord('user-a', { taskId: task.id, conversationId: 'cid-trace', userMessageIds: ['msg-trace'], title: 'Trace task', goalText: 'Inspect the trace' });
  requirement.forecastStatus = 'skipped'; requirement.forecastError = 'projection not confirmed yet';
  task.requirementIds = [requirement.id]; task.currentRequirementId = requirement.id;
  await store.replaceKstarRequirement('user-a', requirement); await store.replaceKstarTask('user-a', task);
  await store.writeConversationTaskState('user-a', { ...store.createInitialConversationTaskState('user-a', 'cid-trace'), currentTaskId: task.id, currentRequirementId: requirement.id, taskComplete: false });
  const trace = await (await import('../../../../src/main/features/kstar/trace')).readKstarTrace('user-a', { conversationId: 'cid-trace' });
  expect(trace.nodes.map((entry) => entry.stage)).toEqual(expect.arrayContaining(['task', 'requirement', 'projection', 'forecast']));
  expect(trace.nodes.find((entry) => entry.stage === 'forecast')).toMatchObject({ status: 'skipped' });
  expect(JSON.stringify(trace)).not.toContain('statement');
});
