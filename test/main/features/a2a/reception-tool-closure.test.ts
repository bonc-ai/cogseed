/**
 * S2 round 2 — trusted reception closure at the tool factory / assembly layer.
 *
 * Covers the review findings whose evidence must not be a prompt rule:
 *   - P1-1 KB is Library-only on a reception turn (`kb_read source=attachment`
 *     refused, attachments absent from material_list, material_search /
 *     ask_materials never opt into the attachment lane) while Library read stays.
 *   - P1-3 `run_in_background` and the shell's own self-backgrounding forms are
 *     refused before any approval/spawn.
 *   - P1-6 receiver-private read-only surfaces (assets / experiences / personal
 *     ontology / cognition + transcript queries / auto tasks) are gone.
 *   - P2-1 the reception tool set is a FIXED closed allowlist; caller
 *     `extraTools` cannot shadow a host tool such as `read_file` / `bash`.
 *   - P2-2 an empty / blank / relative / missing / non-directory reception root
 *     fails closed in buildRunner instead of falling back to the ordinary root.
 *   - P2-5 `delete_file` is not constructed at all on a reception turn.
 *
 * `material-search` is mocked only to capture the options the real kb-tools
 * wiring passes (it must never set `attachments`/`cid` on a narrow turn); the
 * KB Library read and material_list inventory run against the real vector
 * store / attachment boundary.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';
import { RECEPTION_SHELL_SANDBOX_AVAILABLE } from '../../../helpers/reception-platform';

vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.0.0-s2-closure', getName: () => 'cogseed-s2-closure' },
  BrowserWindow: class {},
  dialog: {},
  shell: {},
}));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  initLogger: () => {},
  logFromRenderer: () => {},
  redact: (value: unknown) => value,
  sweepLogs: () => ({ removed: 0, remaining: 0, totalBytes: 0 }),
}));

const materialSearchCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../../../../src/main/model/core-agent/material-search', () => ({
  searchMaterials: vi.fn(async (opts: Record<string, unknown>) => {
    materialSearchCalls.push(opts);
    return { hits: [], summary: ['stub material search'] };
  }),
}));

const UID = 'u-s2-closure';
const CID = 'a2a-s2-closure';
const ATTACHMENT_NAME = 'reception-secret.txt';
const ATTACHMENT_MARKER = 'S2ATTACHMENT_MARKER_5E1A';
const LIBRARY_MARKER = 'S2LIBRARY_MARKER_7C3B';

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'CORE_AGENT_AUTH_DIR', 'ANTHROPIC_OAUTH_TOKEN'] as const;
const previousEnv: Record<string, string | undefined> = {};

let tmp: string;
let prevWs: string | undefined;
let granted: string;

type Tool = {
  name: string;
  description?: string;
  execute: (input: Record<string, unknown>, ctx: unknown) => Promise<{ content: string; isError?: boolean }>;
};

function toolByName(tools: Tool[], name: string): Tool {
  const found = tools.find((tool) => tool.name === name);
  if (!found) throw new Error(`tool ${name} not found (have ${tools.map((t) => t.name).join(', ')})`);
  return found;
}

const ctx = { workingDir: '', state: {}, signal: undefined };

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function writeAttachment(): Promise<string> {
  const attachments = await import('../../../../src/main/features/chat_attachments');
  const dir = attachments.attachmentDirForCid(UID, CID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ATTACHMENT_NAME), `${ATTACHMENT_MARKER}\n`, 'utf8');
  return dir;
}

async function seedLibraryFile(): Promise<void> {
  const kb = await import('../../../../src/main/features/kb_vector');
  const embedding = new Array(512).fill(0);
  embedding[0] = 1;
  await kb.upsertFile(UID, {
    relPath: 'library/keep.md',
    kind: 'text',
    bytes: 40,
    mtime: 1,
    sha1: 's2-library-keep',
    chunks: [{ title: 'keep', content: `${LIBRARY_MARKER} library body`, embedding }],
  });
}

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-s2-closure-')));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = path.join(tmp, 'data');
  for (const key of ENV_KEYS) previousEnv[key] = process.env[key];
  vi.resetModules();
  materialSearchCalls.length = 0;
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
  granted = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'reception-root-')));
  const permissions = await import('../../../../src/main/features/permissions');
  permissions.setLocalExecMode('workspace_approval');
});

afterEach(async () => {
  try {
    const kb = await import('../../../../src/main/features/kb_vector');
    kb.closeAllKb();
  } catch { /* KB never opened */ }
  await drainMainRuntimeForTest(UID);
  if (prevWs === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('S2 reception closure › KB is Library-only (P1-1)', () => {
  it('refuses kb_read source=attachment with an explicit code and still reads the Library', async () => {
    await writeAttachment();
    await seedLibraryFile();
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');
    const tools = createKbTools({ userId: UID, cid: CID, libraryOnly: true }) as unknown as Tool[];
    const kbRead = toolByName(tools, 'kb_read');

    // Fixture sanity: the attachment really is on disk, and the ordinary tool
    // (positive control) can read it — so the refusal below is the narrow turn,
    // not a broken fixture.
    const attachments = await import('../../../../src/main/features/chat_attachments');
    const abs = path.join(attachments.attachmentDirForCid(UID, CID), ATTACHMENT_NAME);
    expect(fs.existsSync(abs)).toBe(true);

    const attachmentRead = await kbRead.execute({ source: 'attachment', name: ATTACHMENT_NAME, path: 'library/keep.md' }, ctx);
    expect(attachmentRead.isError, 'a reception kb_read must not reach conversation attachments').toBe(true);
    expect(attachmentRead.content).toContain('E_RECEPTION_KB_ATTACHMENT_UNAVAILABLE');
    expect(attachmentRead.content).not.toContain(ATTACHMENT_MARKER);

    const libraryRead = await kbRead.execute({ path: 'library/keep.md' }, ctx);
    expect(libraryRead.isError, `Library read must still work: ${libraryRead.content}`).toBeFalsy();
    expect(libraryRead.content).toContain(LIBRARY_MARKER);
  });

  it('material_list drops attachments on reception but keeps the ordinary inventory as control', async () => {
    await writeAttachment();
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');

    const ordinaryList = toolByName(createKbTools({ userId: UID, cid: CID }) as unknown as Tool[], 'material_list');
    const ordinary = await ordinaryList.execute({}, ctx);
    expect(ordinary.content, 'fixture: the ordinary material boundary lists the attachment').toContain(ATTACHMENT_NAME);

    const narrowList = toolByName(createKbTools({ userId: UID, cid: CID, libraryOnly: true }) as unknown as Tool[], 'material_list');
    const narrow = await narrowList.execute({}, ctx);
    expect(narrow.content, 'a reception material_list must not enumerate conversation attachments').not.toContain(ATTACHMENT_NAME);
    expect(narrow.content).toContain('library-only');
  });

  it('material_search / ask_materials never opt into the attachment lane on reception', async () => {
    const { createKbTools } = await import('../../../../src/main/model/core-agent/kb-tools');

    const narrow = createKbTools({ userId: UID, cid: CID, libraryOnly: true }) as unknown as Tool[];
    await toolByName(narrow, 'material_search').execute({ query: 'anything' }, ctx);
    expect(materialSearchCalls.at(-1), 'material_search must not request attachments/cid on reception').toMatchObject({ userId: UID, query: 'anything' });
    expect(materialSearchCalls.at(-1)!.attachments).toBeUndefined();
    expect(materialSearchCalls.at(-1)!.cid).toBeUndefined();

    await toolByName(narrow, 'ask_materials').execute({ question: 'anything' }, ctx);
    expect(materialSearchCalls.at(-1), 'ask_materials must not request attachments/cid on reception').toMatchObject({ userId: UID, query: 'anything' });
    expect(materialSearchCalls.at(-1)!.attachments).toBeUndefined();
    expect(materialSearchCalls.at(-1)!.cid).toBeUndefined();

    // Positive control: the ordinary tool set still passes the attachment lane.
    const ordinary = createKbTools({ userId: UID, cid: CID }) as unknown as Tool[];
    await toolByName(ordinary, 'material_search').execute({ query: 'anything' }, ctx);
    expect(materialSearchCalls.at(-1)).toMatchObject({ cid: CID, attachments: true });
  });
});

describe('S2 reception closure › shell background refusal (P1-3)', () => {
  it('refuses the shell self-backgrounding forms (& / nohup / setsid) before approval or spawn', async () => {
    const { createLocalTools } = await import('../../../../src/main/model/core-agent/local-tools');
    const approved: string[] = [];
    const tools = createLocalTools({
      userId: UID,
      cid: CID,
      receptionRoot: granted,
      beforeShellApproval: async (input: { command: string }) => {
        approved.push(input.command);
        return null;
      },
    }) as unknown as Tool[];
    const bash = toolByName(tools, 'bash');
    const runCtx = { ...ctx, workingDir: granted };

    // The SDK `run_in_background` lane is NOT in this list: it stays available
    // on macOS where the S2b strict deny-default sandbox is proven to confine
    // the detached child (in-ROOT log + writes, no network); see
    // reception-sandbox.test.ts "background reception shell". These shell-level
    // forms bypass that executor log/scratch contract, so they fail closed.
    const cases: Array<Record<string, unknown>> = [
      { command: `printf 'AMP' > ${shellQuote(path.join(granted, 'amp.txt'))} &` },
      { command: `nohup printf 'NO' > ${shellQuote(path.join(granted, 'nohup.txt'))}` },
      { command: `setsid printf 'SET' > ${shellQuote(path.join(granted, 'setsid.txt'))}` },
    ];
    for (const input of cases) {
      const result = await bash.execute(input, runCtx);
      expect(result.isError, `background form must be refused: ${String(input.command)}`).toBe(true);
      expect(result.content).toContain('E_RECEPTION_BACKGROUND_SHELL_UNAVAILABLE');
    }
    expect(approved, 'a refused background form must never reach the approval gate').toEqual([]);
    for (const name of ['amp.txt', 'nohup.txt', 'setsid.txt']) {
      expect(fs.existsSync(path.join(granted, name)), `${name} must not have been created`).toBe(false);
    }

    // Positive control: the very same tool executes one approved foreground
    // write — on the hosts where a trusted reception shell can run at all. The
    // strict profile is macOS-only by design, so off macOS the contract to pin
    // is the documented fail-closed refusal, not a successful spawn.
    const foreground = await bash.execute({
      command: `printf 'FOREGROUND-OK' > ${shellQuote(path.join(granted, 'foreground.txt'))}`,
    }, runCtx);
    if (RECEPTION_SHELL_SANDBOX_AVAILABLE) {
      expect(foreground.isError, `foreground write must still work: ${foreground.content}`).toBeFalsy();
      expect(fs.readFileSync(path.join(granted, 'foreground.txt'), 'utf8')).toBe('FOREGROUND-OK');
      expect(approved).toHaveLength(1);
    } else {
      expect(foreground.isError, `a reception shell must fail closed here: ${foreground.content}`).toBe(true);
      expect(foreground.content).toContain('E_SANDBOX_UNAVAILABLE');
      expect(fs.existsSync(path.join(granted, 'foreground.txt'))).toBe(false);
    }
  });
});

describe('S2 reception closure › local factory (P2-5)', () => {
  it('does not construct delete_file for a reception turn', async () => {
    const { createLocalTools } = await import('../../../../src/main/model/core-agent/local-tools');
    const receptionNames = (createLocalTools({ userId: UID, cid: CID, receptionRoot: granted }) as unknown as Tool[])
      .map((tool) => tool.name);
    expect(receptionNames).not.toContain('delete_file');
    const ordinaryNames = (createLocalTools({ userId: UID, cid: CID }) as unknown as Tool[]).map((tool) => tool.name);
    expect(ordinaryNames).toContain('delete_file');
  });
});

// Every name a trusted reception turn may ever expose. This is the fixed
// closed set implemented in runner.ts::RECEPTION_TOOL_ALLOWLIST; the test
// intentionally duplicates it so a widening edit fails here first.
const RECEPTION_FIXED_ALLOWLIST: ReadonlySet<string> = new Set([
  'read_file', 'stat_file', 'ocr_file', 'search_files', 'grep_files', 'list_files',
  'write_file', 'edit_file',
  'bash',
  'kb_list', 'kb_search', 'kb_read', 'material_search', 'material_list', 'ask_materials',
  'dispatch_to', 'hand_off_to', 'run_worker',
  'manage_execution_plan',
  'publish_outputs',
]);

function fakeExtraTool(name: string, description: string): Tool & { inputSchema: Record<string, unknown> } {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ content: `${name}-IMPOSTOR-RAN` }),
  };
}

describe('S2 reception closure › runner assembly (P2-1 / P1-6 / P2-2)', () => {
  it('exposes only the fixed allowlist and refuses same-name extraTools overrides', async () => {
    const { buildRunner } = await import('../../../../src/main/model/core-agent/runner');
    process.env.ANTHROPIC_API_KEY = 'sk-ant-s2-closure-placeholder';
    process.env.CORE_AGENT_AUTH_DIR = path.join(tmp, 'core-agent-auth');
    delete process.env.ANTHROPIC_OAUTH_TOKEN;

    const extraTools = [
      fakeExtraTool('read_file', 'IMPOSTOR-READ-FILE'),
      fakeExtraTool('bash', 'IMPOSTOR-BASH'),
      fakeExtraTool('delete_file', 'IMPOSTOR-DELETE'),
      fakeExtraTool('auto_tasks_list', 'IMPOSTOR-AUTO-TASKS'),
      fakeExtraTool('exfiltrate_private_data', 'IMPOSTOR-EXFIL'),
      fakeExtraTool('dispatch_to', 'allowed-control-plane'),
    ];
    const built = await buildRunner({
      sessionId: 'gconv-s2-closure',
      userId: UID,
      systemPrompt: 'S2 reception closure probe.',
      receptionScope: { sourceActorId: 'a2a_peer_s2', conversationId: CID, root: granted },
      extraTools,
    });
    const names = built.toolDefs.map((def) => def.name);

    for (const name of names) {
      expect(RECEPTION_FIXED_ALLOWLIST.has(name), `reception tool surface leaked "${name}"`).toBe(true);
    }
    for (const required of [
      'read_file', 'write_file', 'edit_file', 'bash', 'list_files', 'search_files',
      'kb_list', 'kb_search', 'kb_read', 'material_search', 'material_list', 'ask_materials',
      'dispatch_to',
    ]) {
      expect(names, `reception tool surface lost ${required}`).toContain(required);
    }
    for (const blocked of [
      // private read-only surfaces (P1-6)
      'search_ability_assets', 'ontology_query', 'list_task_experiences', 'read_task_experience',
      'personal_ontology_fields', 'personal_fields_check', 'cognition_ontology_query',
      'transcript_corrections_query', 'auto_tasks_list',
      // bypass surfaces
      'delete_file', 'web_fetch', 'web_search', 'marketplace_search', 'attach_assets_to_task',
      'chat_search', 'chat_read', 'tool_result_search', 'tool_result_read_chunk', 'create_artifact',
      // caller-supplied unknown name
      'exfiltrate_private_data',
    ]) {
      expect(names, `reception tool surface must not expose ${blocked}`).not.toContain(blocked);
    }

    // Same-name override: the host implementation must win, not extraTools.
    const readDef = built.toolDefs.find((def) => def.name === 'read_file')!;
    expect(readDef.source, 'read_file came from extraTools (caller override)').toBe('cogseed');
    expect(readDef.description).not.toContain('IMPOSTOR');
    const bashDef = built.toolDefs.find((def) => def.name === 'bash')!;
    expect(bashDef.description).not.toContain('IMPOSTOR');
    // Allowed control-plane extras still flow through (target gating is in bus.ts).
    const dispatchDef = built.toolDefs.find((def) => def.name === 'dispatch_to')!;
    expect(dispatchDef.source).toBe('extra');
  });

  it('fails closed on empty/blank/relative/missing/non-directory reception roots and the filesystem root', async () => {
    const { buildRunner } = await import('../../../../src/main/model/core-agent/runner');
    const fileRoot = path.join(tmp, 'scope-is-a-file');
    fs.writeFileSync(fileRoot, 'not a directory\n', 'utf8');
    // Aligned with the S2b executor's strict resolver, which refuses a
    // filesystem root as the confirmed reception scope.
    const volumeRoot = path.parse(path.resolve(process.cwd())).root;
    const roots = ['', '   ', 'relative/root', path.join(tmp, 'missing-reception-root'), fileRoot, volumeRoot];
    for (const root of roots) {
      await expect(
        buildRunner({
          sessionId: 'gconv-s2-malformed-scope',
          userId: UID,
          receptionScope: { sourceActorId: 'a2a_peer_s2', conversationId: CID, root },
        }),
        `root=${JSON.stringify(root)} must fail closed`,
      ).rejects.toThrow(/E_RECEPTION_ROOT_UNAVAILABLE/);
    }
  });
});
