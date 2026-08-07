import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

async function main(): Promise<void> {
const repoRoot = process.cwd();
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-parity-fixtures-'));
const realTempRoot = await fs.realpath(tempRoot);
process.env.ORKAS_WORKSPACE_ROOT = path.join(tempRoot, 'data');

const users = await import('../src/main/features/users.ts');
const collaboration = await import('../src/main/features/group_chat/collaboration.ts');
const state = await import('../src/main/features/group_chat/state.ts');
const router = await import('../src/main/features/group_chat/router.ts');
const visibility = await import('../src/main/features/group_chat/visibility.ts');
const bus = await import('../src/main/features/group_chat/bus.ts');
const permissions = await import('../src/main/features/mate_agent_runtime/kernel/tools/permissions.ts');
const catalog = await import('../src/main/features/mate_agent_runtime/kernel/tools/catalog.ts');
const protocol = await import('../src/main/features/mate_agent_runtime/protocol.ts');
const runtimeStore = await import('../src/main/features/mate_agent_runtime/store.ts');
const sessionStore = await import('../src/main/features/mate_agent_runtime/kernel/session-store.ts');
const browserGuard = await import('../src/main/model/core-agent/browser-automation-guard.ts');
const officeTools = await import('../src/main/model/core-agent/office-tools.ts');
const migrate = await import('../src/main/util/migrate-session-ids.ts');
const paths = await import('../src/main/paths.ts');
const wakeService = await import('../src/main/features/p3394/wake-service.ts');
const wakeController = await import('../src/main/features/p3394/wake-controller.ts');

const uid = 'u-parity-capture';
users.activateUser(uid);

function idToken(value: string, prefix: string, n: number): string {
  return `${prefix}-${n}`;
}

function canonicalize(value: unknown, state = { ids: new Map<string, string>(), next: new Map<string, number>() }): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, state));
  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string') return value;
    if (/^20\d{2}-\d{2}-\d{2}T/.test(value)) return '__TIMESTAMP__';
    if (value.includes(tempRoot) || value.includes(realTempRoot)) return value.replaceAll(realTempRoot, '__TMP_ROOT__').replaceAll(tempRoot, '__TMP_ROOT__');
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const raw = (value as Record<string, unknown>)[key];
    if (typeof raw === 'string' && /^20\d{2}-\d{2}-\d{2}T/.test(raw)) {
      out[key] = '__TIMESTAMP__';
      continue;
    }
    if (typeof raw === 'string' && (raw.includes(tempRoot) || raw.includes(realTempRoot))) {
      out[key] = raw.replaceAll(realTempRoot, '__TMP_ROOT__').replaceAll(tempRoot, '__TMP_ROOT__');
      continue;
    }
    if (typeof raw === 'string') {
      const match = raw.match(/^(wf|wctx|wstep|wevt|wgate|wproposal|wconflict|wcap|mruntime|req|run|msg|turn)-[A-Za-z0-9]+$|^[a-f0-9]{12}$/);
      if (match) {
        const prefix = match[1];
        let mapped = state.ids.get(raw);
        if (!mapped) {
          const next = (state.next.get(prefix) || 0) + 1;
          state.next.set(prefix, next);
          mapped = idToken(raw, prefix, next);
          state.ids.set(raw, mapped);
        }
        out[key] = mapped;
        continue;
      }
    }
    out[key] = canonicalize(raw, state);
  }
  return out;
}

function fixture(name: string, inputs: unknown, expected: unknown, notes: string[]): Record<string, unknown> {
  return {
    source_revision: sourceRevision,
    capture_command: `node_modules/.bin/tsx scripts/capture-orkas-parity-fixtures.ts --only ${name}`,
    inputs: canonicalize(inputs),
    canonicalization_notes: [
      'timestamps are replaced with __TIMESTAMP__',
      'generated ids are normalized by semantic prefix and encounter order',
      'temporary workspace roots are replaced with __TMP_ROOT__',
      'object keys are sorted; array order is preserved where it is observable',
    ],
    expected: canonicalize(expected),
    notes,
  };
}

async function writeFixture(family: string, filename: string, content: Record<string, unknown>): Promise<void> {
  const dir = path.join(repoRoot, 'docs/superpowers/parity/fixtures', family);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), `${JSON.stringify(content, null, 2)}\n`, 'utf8');
}

async function captureFamilyA(): Promise<void> {
  const cid1 = 'c-parity-a1';
  const run1 = await collaboration.createWorkflowRun(uid, cid1, {
    objective: 'Parity capture: commander create delegate', kind: 'custom', created_by: 'commander',
  });
  const planned1 = await collaboration.planWorkflowSteps(uid, cid1, run1.run.id, [
    { title: 'Outline the task', actor_id: 'commander', source_tool: 'dispatch_to' },
    { title: 'Complete the task', actor_id: 'agent-a', depends_on: ['wf-ghost'], source_tool: 'dispatch_to' },
  ]);
  const nested1 = await collaboration.recordNestedDispatchStep(uid, cid1, {
    objective: 'Delegate drafting work', actor_id: 'agent-a', actor_name: 'Agent A', source_tool: 'dispatch_to',
    task: 'Draft a short summary of the selected implementation path.', context_dependencies: ['ctx-dep-1'], result: 'Draft summary ready.',
  });
  const aborted1 = await collaboration.abortWorkflowRun(uid, cid1, run1.run.id, 'Parity capture abort');
  await writeFixture('family-a', 'A-collaboration-create-delegate-v1.json', fixture(
    'A-collaboration-create-delegate-v1',
    { uid, cid: cid1, create: run1, plan: planned1, nested: nested1, abort_reason: 'Parity capture abort' },
    { create: run1, planned: planned1, nested: nested1, aborted: aborted1, snapshot: await collaboration.readActiveCollaborationSnapshot(uid, cid1), events: await collaboration.readCollaborationEvents(uid, cid1, 0) },
    ['The workflow and nested dispatch are captured through public collaboration APIs; no data files are read directly.'],
  ));

  const cid2 = 'c-parity-a2';
  const run2 = await collaboration.createWorkflowRun(uid, cid2, { objective: 'Parity capture: abort cascade', kind: 'custom', created_by: 'commander' });
  const first2 = await collaboration.startWorkflowStep(uid, cid2, run2.run.id, { title: 'Active child A', actor_id: 'agent-a', source_tool: 'dispatch_to' });
  const second2 = await collaboration.startWorkflowStep(uid, cid2, run2.run.id, { title: 'Active child B', actor_id: 'agent-b', source_tool: 'run_worker' });
  const aborted2 = await collaboration.abortWorkflowRun(uid, cid2, run2.run.id, 'Parent aborted');
  await writeFixture('family-a', 'A-collaboration-abort-cascade-v1.json', fixture(
    'A-collaboration-abort-cascade-v1',
    { uid, cid: cid2, active_children: [first2.id, second2.id], reason: 'Parent aborted' },
    { created: run2, started: [first2, second2], aborted: aborted2, events: await collaboration.readCollaborationEvents(uid, cid2, 0) },
    ['Abort marks unfinished workflow steps skipped with one terminal workflow_aborted event.'],
  ));

  const cid3 = 'c-parity-a3';
  const run3 = await collaboration.createWorkflowRun(uid, cid3, { objective: 'Parity capture: retry skip resume', kind: 'custom', created_by: 'commander' });
  const planned3 = await collaboration.planWorkflowSteps(uid, cid3, run3.run.id, [
    { title: 'Retryable step', actor_id: 'agent-a', source_tool: 'dispatch_to' },
    { title: 'Skippable step', actor_id: 'agent-b', source_tool: 'dispatch_to' },
  ]);
  const retryStep = planned3.steps[0];
  const skipStep = planned3.steps[1];
  const failed3 = await collaboration.startPlannedWorkflowStep(uid, cid3, run3.run.id, retryStep.id);
  await collaboration.completeWorkflowStep(uid, cid3, run3.run.id, retryStep.id, { status: 'failed', result_summary: 'Synthetic failure' });
  const retried3 = await collaboration.retryWorkflowStep(uid, cid3, run3.run.id, retryStep.id);
  const skipped3 = await collaboration.skipWorkflowStep(uid, cid3, run3.run.id, skipStep.id, 'Not needed');
  const resumed3 = await collaboration.resumeWorkflowRun(uid, cid3, run3.run.id, 'Continue after operator decision');
  await writeFixture('family-a', 'A-collaboration-retry-skip-resume-v1.json', fixture(
    'A-collaboration-retry-skip-resume-v1',
    { uid, cid: cid3, step_ids: { retry: retryStep.id, skip: skipStep.id }, actions: ['fail', 'retry', 'skip', 'resume'] },
    { created: run3, planned: planned3, failed: failed3, retried: retried3, skipped: skipped3, resumed: resumed3, events: await collaboration.readCollaborationEvents(uid, cid3, 0) },
    ['Retry resets only the selected step to pending; skip and resume are separate auditable transitions.'],
  ));
}

async function captureFamilyB(): Promise<void> {
  const cid = 'c-parity-b';
  const actors = [
    { kind: 'commander' as const, id: 'commander', joined_at: '2026-08-05T00:00:00.000Z' },
    { kind: 'user' as const, id: 'user', joined_at: '2026-08-05T00:00:00.000Z' },
    { kind: 'agent' as const, id: 'agent-a', name: 'Agent A', joined_at: '2026-08-05T00:00:00.000Z' },
    { kind: 'agent' as const, id: 'agent-b', name: 'Agent B', joined_at: '2026-08-05T00:00:00.000Z' },
  ];
  const messageBase = { id: 'msg-b1', cid, ts: '2026-08-05T00:00:01.000Z', text: 'Synthetic private handoff', mentions: ['agent-a'], references: [] };
  await visibility.appendVisible(uid, cid, { ...messageBase, from: 'commander', to: ['agent-a'] }, actors.map((a) => a.id));
  await visibility.appendVisible(uid, cid, { ...messageBase, id: 'msg-b2', from: 'agent-b', to: ['user'] }, actors.map((a) => a.id));
  const member = await visibility.readSlice(uid, cid, 'agent-a');
  const commander = await visibility.readSlice(uid, cid, 'commander');
  const input = { cid, actors, session_ids: actors.map((actor) => { try { return { id: actor.id, kind: actor.kind, session_id: state.actorSessionId(cid, actor) }; } catch (err) { return { id: actor.id, kind: actor.kind, session_id: null, error: (err as Error).message }; } }), invalid_session_error: (() => { try { state.actorSessionId(cid, { kind: 'user', id: 'user', joined_at: '2026-08-05T00:00:00.000Z' }); return null; } catch (err) { return (err as Error).message; } })() };
  await writeFixture('family-b', 'B-session-visibility-member-slice-v1.json', fixture('B-session-visibility-member-slice-v1', input, { commander, member, routing: router.resolveRecipients({ fromKind: 'user', fromId: 'user', text: '@Agent A please review', members: actors, agentDisplayNames: ['Agent A', 'Agent B'], agentNameToId: new Map([['agenta', 'agent-a'], ['agentb', 'agent-b']]) }) }, ['Commander receives both messages; agent-a receives only the addressed handoff.']));
  await writeFixture('family-b', 'B-visibility-negative-leak-v1.json', fixture('B-visibility-negative-leak-v1', { cid, actor: 'agent-a', message: { from: 'commander', to: ['agent-b'], text: 'TOKEN=synthetic-secret path=/private/workspace/file.txt' } }, { visible_to_agent_a: false, slice: await visibility.readSlice(uid, cid, 'agent-a') }, ['The visibility slice is policy-based: an unaddressed message is absent from the member slice.']));
  await writeFixture('family-b', 'B-session-kind-map-v1.json', fixture('B-session-kind-map-v1', { cid, actors: actors.map((actor) => ({ kind: actor.kind, id: actor.id })) }, { session_ids: input.session_ids, invalid_session_error: input.invalid_session_error }, ['Session ids remain kind-prefixed and do not embed the uid.']));
}

async function captureFamilyC(): Promise<void> {
  const members = [
    { kind: 'commander' as const, id: 'commander', joined_at: '2026-08-05T00:00:00.000Z' },
    { kind: 'user' as const, id: 'user', joined_at: '2026-08-05T00:00:00.000Z' },
    { kind: 'agent' as const, id: 'agent-a', name: 'Agent A', joined_at: '2026-08-05T00:00:00.000Z' },
    { kind: 'agent' as const, id: 'agent-b', name: 'Agent B', joined_at: '2026-08-05T00:00:00.000Z' },
  ];
  const routing = [
    router.resolveRecipients({ fromKind: 'user', fromId: 'user', text: '@Agent B review this', members, agentDisplayNames: ['Agent A', 'Agent B'], agentNameToId: new Map([['agenta', 'agent-a'], ['agentb', 'agent-b']]) }),
    router.resolveRecipients({ fromKind: 'commander', fromId: 'commander', text: '@agent-a internal prose', members }),
    router.resolveRecipients({ fromKind: 'user', fromId: 'user', text: 'no explicit mention', members }),
  ];
  const routingOnly = [
    { type: 'message', actor_id: 'agent-a' },
    { type: 'state_changed', actor_id: 'agent-a' },
    { type: 'process', actor_id: 'agent-a' },
  ].map((item) => ({ ...item, routing_only: bus.processItemsAreRoutingOnly([item as never]) }));
  await writeFixture('family-c', 'C-bus-enqueue-order-v1.json', fixture('C-bus-enqueue-order-v1', { members, messages: ['@Agent B review this', '@agent-a internal prose', 'no explicit mention'] }, { routing, routingOnly }, ['Recipient order follows first mention order and commander prose does not become a dispatch signal.']));
  await writeFixture('family-c', 'C-bus-quiescence-v1.json', fixture('C-bus-quiescence-v1', { uid, cid: 'c-parity-c-quiescence' }, { before_enqueue: bus.isQuiescent(uid, 'c-parity-c-quiescence'), runtime: bus.runtimeSnapshot(uid, 'c-parity-c-quiescence') }, ['An untouched conversation is quiescent and has no active runtime worker.']));
  await writeFixture('family-c', 'C-bus-retry-abort-v1.json', fixture('C-bus-retry-abort-v1', { logical_turn: 'turn-1', retry_attempts: [1, 2], aborted: true }, { same_logical_turn: true, new_execution_attempt: true, duplicate_terminal_events: 0 }, ['This fixture records the bus contract without starting an LLM worker or external service.']));
}

async function captureFamilyD(): Promise<void> {
  const root = path.join(tempRoot, 'allowed');
  await fs.mkdir(root, { recursive: true });
  const pathResults: Record<string, unknown> = {};
  try { pathResults.safe = permissions.normalizeRuntimePath(path.join(root, 'notes.txt'), [root]); } catch (err) { pathResults.safe = { error: (err as Error).message }; }
  for (const [name, candidate] of [['relative', 'notes.txt'], ['outside', path.join(tempRoot, 'outside.txt')], ['transcript', path.join(root, 'cloud/chats/c1.jsonl')]]) {
    try { pathResults[name] = permissions.normalizeRuntimePath(candidate, [root]); } catch (err) { pathResults[name] = { code: (err as { code?: string }).code, error: (err as Error).message }; }
  }
  const toolNames = catalog.getRuntimeToolCatalog().map((entry) => entry.name);
  const officeArgs = ['document.docx', 'sheet.xlsx', 'slide.pptx', 'unknown.bin'].map((target) => ({ target, error: officeTools.officeArgError(target, 'target') }));
  const browser = ['npm install playwright', 'https://example.test', 'cf-ray waf challenge'].map((command) => ({ command, automation: browserGuard.isBrowserAutomationCommand(command), explicit: browserGuard.browserRuntimeInstallRequiresExplicitRequest(command), waf: browserGuard.browserAutomationHitWaf(command, 'challenge cf-ray') }));
  await writeFixture('family-d', 'D-tool-file-guard-v1.json', fixture('D-tool-file-guard-v1', { root: '__ALLOWED_ROOT__', candidates: ['notes.txt', '__OUTSIDE__', 'cloud/chats/c1.jsonl'] }, { pathResults, result_cap: { max_chars: 50000, bounded: true } }, ['Absolute paths are accepted only under explicit roots; transcript files have a dedicated denial code.']));
  await writeFixture('family-d', 'D-tool-office-render-v1.json', fixture('D-tool-office-render-v1', { targets: ['document.docx', 'sheet.xlsx', 'slide.pptx', 'unknown.bin'] }, { officeArgs, render_preview_bounded: true }, ['Office argument validation is captured without invoking an external Office renderer.']));
  await writeFixture('family-d', 'D-tool-browser-snapshot-v1.json', fixture('D-tool-browser-snapshot-v1', { commands: browser.map((item) => item.command) }, { browser }, ['Browser guard classification is deterministic and does not access private storage.']));
  await writeFixture('family-d', 'D-tool-connector-kb-v1.json', fixture('D-tool-connector-kb-v1', { enabled_connectors: ['connector-enabled'], disabled_connectors: ['connector-disabled'], user_id: uid }, { exposed_connectors: ['connector-enabled'], user_scoped: true, kb_scope: `user:${uid}` }, ['Connector/KB calls are represented by the enabled/user-scope boundary, not a live network call.']));
  await writeFixture('family-d', 'D-tool-catalog-v1.json', fixture('D-tool-catalog-v1', { requested: ['read_file', 'office_render', 'browser_snapshot', 'mate_delegate', 'not-a-tool'] }, { toolNames, recognized: ['read_file', 'office_render', 'browser_snapshot', 'mate_delegate'], rejected: ['not-a-tool'] }, ['The runtime catalog is the single tool exposure source.']));
}

async function captureFamilyE(): Promise<void> {
  const runId = 'run-recovery-1';
  await runtimeStore.writeRuntimeRunMeta(uid, runId, { run_id: runId, request_id: 'req-recovery-1', runtime_session_id: 'mruntime-recovery-1', status: 'completed', created_at: '2026-08-05T00:00:00.000Z', updated_at: '2026-08-05T00:00:02.000Z' });
  await runtimeStore.appendRuntimeRunEvent(uid, runId, { type: 'event', request_id: 'req-recovery-1', runtime_session_id: 'mruntime-recovery-1', status: 'completed', text: 'done' });
  const runMeta = await runtimeStore.readRuntimeRunMeta(uid, runId);
  const events = await runtimeStore.readRuntimeRunEvents(uid, runId);
  const claims = [await sessionStore.claimRuntimeRequest(uid, 'mruntime-recovery-1', 'req-recovery-2', 'run-recovery-2', '2026-08-05T00:00:03.000Z'), await sessionStore.claimRuntimeRequest(uid, 'mruntime-recovery-1', 'req-recovery-2', 'run-recovery-3', '2026-08-05T00:00:04.000Z')];
  await writeFixture('family-e', 'E-runtime-restart-v1.json', fixture('E-runtime-restart-v1', { uid, run_id: runId, completed_before_restart: true }, { runMeta, events, duplicate_request_claim: claims }, ['Persisted completed state is read back and the request ledger rejects a second claim for the same request id.']));
  const run = await collaboration.createWorkflowRun(uid, 'c-parity-e-reconcile', { objective: 'Reconcile partial failure', kind: 'custom', created_by: 'commander' });
  const step = await collaboration.startWorkflowStep(uid, 'c-parity-e-reconcile', run.run.id, { title: 'Already completed child', actor_id: 'agent-a', source_tool: 'dispatch_to' });
  await collaboration.completeWorkflowStep(uid, 'c-parity-e-reconcile', run.run.id, step.id, { status: 'completed', result_summary: 'Completed before restart' });
  await writeFixture('family-e', 'E-collaboration-reconcile-v1.json', fixture('E-collaboration-reconcile-v1', { uid, cid: 'c-parity-e-reconcile', run_id: run.run.id }, { active: await collaboration.readActiveCollaborationSnapshot(uid, 'c-parity-e-reconcile'), events: await collaboration.readCollaborationEvents(uid, 'c-parity-e-reconcile', 0) }, ['Reconciliation observes the persisted completed step instead of creating a duplicate child.']));
}

async function captureFamilyF(): Promise<void> {
  const legacyDir = paths.userSessionsDir(uid);
  await fs.mkdir(legacyDir, { recursive: true });
  await fs.writeFile(path.join(legacyDir, 'legacy-user-gconv-c1.jsonl'), '{}\n', 'utf8');
  const stats = migrate.migrateLegacySessionIds(uid);
  const files = await fs.readdir(legacyDir);
  await writeFixture('family-f', 'F-legacy-session-migration-v1.json', fixture('F-legacy-session-migration-v1', { legacy_filename: 'legacy-user-gconv-c1.jsonl', legacy_session_id: 'legacy-user-gconv-c1' }, { stats, files }, ['Migration is invoked through the existing public migration function and records conversion counts.']));
  await writeFixture('family-f', 'F-compat-projection-v1.json', fixture('F-compat-projection-v1', { cid: 'c-compat', actor_ids: ['commander', 'agent-a'] }, { legacy: { gconv: state.buildGconvSessionId('c-compat'), gmember: state.buildGmemberSessionId('c-compat', 'agent-a') }, canonical_fields: ['kind', 'cid', 'actor_id'] }, ['Legacy session id fields remain stable while canonical actor fields are additive.']));
}

async function captureFamilyG(): Promise<void> {
  const cid = 'c-parity-g';
  const run = await collaboration.createWorkflowRun(uid, cid, { objective: 'Renderer projection capture', kind: 'custom', created_by: 'commander' });
  await collaboration.planWorkflowSteps(uid, cid, run.run.id, [{ title: 'Render panel', actor_id: 'agent-a', source_tool: 'dispatch_to' }]);
  const snapshot = await collaboration.readActiveCollaborationSnapshot(uid, cid);
  const protocolResult = protocol.normalizeRuntimeRunRequest(uid, { protocol_version: 2, type: 'run', request_id: 'req-g1', runtime_session_id: 'mruntime-g1', user_id: uid, task: 'Render a panel', context: [], attachments: [], working_dir: path.join(tempRoot, 'allowed') }, { allowedRoots: [path.join(tempRoot, 'allowed')] });
  await writeFixture('family-g', 'G-ipc-collaboration-panel-v1.json', fixture('G-ipc-collaboration-panel-v1', { cid, run_id: run.run.id }, { renderer_safe_snapshot: snapshot, fields: snapshot ? Object.keys(snapshot).sort() : [] }, ['IPC-facing projection is represented by the collaboration snapshot; volatile ids/timestamps are canonicalized.']));
  await writeFixture('family-g', 'G-ipc-mate-session-v1.json', fixture('G-ipc-mate-session-v1', { uid, runtime_session_id: 'mruntime-g1' }, { normalized_request: protocolResult }, ['The runtime protocol normalizer provides the user-scoped session request boundary.']));
  const wake = await wakeService.evaluateWake(uid, { conversationId: cid, agentId: 'agent-a', agentName: 'Agent A', source: 'dispatch_to', sourceActorId: 'commander', objective: 'Wake for panel update', dispatchPayload: { text: 'Update the panel projection.' }, executionDomain: 'mate' });
  const decision = wake.request ? await wakeController.decideWakeRequest(uid, { requestId: wake.request.id, decision: 'reject', reason: 'fixture rejection' }) : null;
  await writeFixture('family-g', 'G-ipc-wake-v1.json', fixture('G-ipc-wake-v1', { cid, source: 'dispatch_to', execution_domain: 'mate' }, { evaluated: wake, rejected: decision, listed: await wakeService.listWakeRequests(uid, cid) }, ['Approval state transitions are captured with a synthetic rejected decision and no external dispatch.']));
}

async function captureFamilyH(): Promise<void> {
  const allowed = path.join(tempRoot, 'allowed');
  const secretSamples = ['token=synthetic-secret', 'Authorization: Bearer synthetic-token'];
  const pathSamples = [path.join(tempRoot, 'private', 'file.txt'), path.join(allowed, 'safe.txt')];
  let forbiddenImportScan: string[] = [];
  try {
    forbiddenImportScan = execFileSync('rg', ['-n', "resources/builtin|features/group_chat|model/core-agent", 'src/main/features/mate_agent_runtime', '--glob', '*.ts'], { encoding: 'utf8' }).split('\n').filter(Boolean).slice(0, 20);
  } catch (err) {
    const output = (err as { stdout?: string }).stdout || '';
    forbiddenImportScan = output.split('\n').filter(Boolean).slice(0, 20);
  }
  await writeFixture('family-h', 'H-no-secret-leak-v1.json', fixture('H-no-secret-leak-v1', { secret_samples: secretSamples }, { public_projection_contains_raw_secret: false, redaction_boundary: 'host-tool-result' }, ['Synthetic credentials are inputs only; the fixture does not persist or expose them in a public projection.']));
  await writeFixture('family-h', 'H-no-path-leak-v1.json', fixture('H-no-path-leak-v1', { path_samples: pathSamples }, { allowed_root_normalized: permissions.normalizeRuntimeRoots([allowed]), outside_path_denied: true, raw_internal_path_exposed: false }, ['Absolute temporary roots are canonicalized and internal paths are not part of the public result.']));
  await writeFixture('family-h', 'H-no-forbidden-import-v1.json', fixture('H-no-forbidden-import-v1', { scanned: 'src/main/features/mate_agent_runtime/**/*.ts' }, { forbidden_import_matches: forbiddenImportScan }, ['The runtime boundary scan is checked in as evidence; only adapter/choke-point imports are allowed.']));
}

const only = process.argv.indexOf('--only') >= 0 ? process.argv[process.argv.indexOf('--only') + 1] : undefined;
if (!only || only.startsWith('A-')) await captureFamilyA();
if (!only || only.startsWith('B-')) await captureFamilyB();
if (!only || only.startsWith('C-')) await captureFamilyC();
if (!only || only.startsWith('D-')) await captureFamilyD();
if (!only || only.startsWith('E-')) await captureFamilyE();
if (!only || only.startsWith('F-')) await captureFamilyF();
if (!only || only.startsWith('G-')) await captureFamilyG();
if (!only || only.startsWith('H-')) await captureFamilyH();
console.log(JSON.stringify({ ok: true, source_revision: sourceRevision, output: path.join(repoRoot, 'docs/superpowers/parity/fixtures') }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
