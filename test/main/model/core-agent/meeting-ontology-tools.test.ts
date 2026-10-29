import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/features/recall/store-events', () => ({
  notifyCognitionWrite: vi.fn(),
}));

const UID = 'test-user-meeting-ontology-core';
let tmpDir: string;
let workspace: string;
let previousRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-meeting-ontology-core-'));
  workspace = path.join(tmpDir, 'meeting-workspace');
  fs.mkdirSync(workspace, { recursive: true });
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const RECORD = {
  schema: 'meeting_record.v1',
  meeting: { ref: 'tm-core-001', title: '本体对齐会', minutes_version: 'v001', confirmed: true },
  participants: [{ name: '樊中扬' }],
  decisions: [{ id: 'D1', text: '会议与本体结合先做原型', source_refs: ['原始转写 v001 · U0002'] }],
  open_questions: [],
  action_items: [{ id: 'A1', text: '整理接口需求给本体同事', derived_from: ['D1'], source_refs: [] }],
};

describe('meeting ontology core-agent tools', () => {
  it('exposes the same tool names and parameters as the Runtime host tools', async () => {
    const { createMeetingOntologyTools } = await import('../../../../src/main/model/core-agent/meeting-ontology-tools');
    const { getRuntimeToolCatalog } = await import('../../../../src/main/features/cogseed_runtime/kernel/tools/catalog');
    const core = createMeetingOntologyTools({ userId: UID });
    for (const tool of core) {
      const runtime = getRuntimeToolCatalog().find((entry) => entry.name === tool.name);
      expect(runtime, tool.name).toBeDefined();
      expect(Object.keys((tool.inputSchema as { properties: object }).properties).sort())
        .toEqual(Object.keys((runtime!.parameters as { properties: object }).properties).sort());
    }
  });

  it('projects a record from a visible root and stays idempotent across both execution paths', async () => {
    const { createMeetingOntologyTools } = await import('../../../../src/main/model/core-agent/meeting-ontology-tools');
    const { runOntologyHostTool } = await import('../../../../src/main/features/cogseed_backend/ontology-host-adapter');
    const graph = await import('../../../../src/main/features/ontology_graph');
    fs.writeFileSync(path.join(workspace, 'record.json'), JSON.stringify(RECORD), 'utf8');

    const tools = createMeetingOntologyTools({ userId: UID, extraRoots: [workspace] });
    const apply = tools.find((tool) => tool.name === 'ontology_projection_apply')!;
    const result = await apply.execute({ record_path: 'record.json' }, { workingDir: workspace } as never);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content).entities).toMatchObject({ created: 3 });

    const viaRuntime = await runOntologyHostTool('ontology_projection_apply', { record_path: path.join(workspace, 'record.json') }, {
      userId: UID, requestId: 'req-1', runtimeSessionId: 'mruntime-1', readOnlyRoots: [workspace], writableRoots: [workspace],
    });
    expect(JSON.parse(viaRuntime.content).entities).toEqual({ created: 0, updated: 0, unchanged: 3, archived: 0 });
    expect((await graph.readOntologyGraph(UID)).entities).toHaveLength(3);

    const read = tools.find((tool) => tool.name === 'ontology_graph_read')!;
    const page = JSON.parse((await read.execute({ category: '会议决议' }, { workingDir: workspace } as never)).content);
    expect(page.entities).toEqual([expect.objectContaining({ name: '会议与本体结合先做原型', category: '决策 > 会议决议' })]);
  });

  it('rejects record files outside the conversation-visible roots', async () => {
    const { createMeetingOntologyTools } = await import('../../../../src/main/model/core-agent/meeting-ontology-tools');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-meeting-ontology-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'record.json'), JSON.stringify(RECORD), 'utf8');
      const tools = createMeetingOntologyTools({ userId: UID, extraRoots: [workspace] });
      const apply = tools.find((tool) => tool.name === 'ontology_projection_apply')!;
      const result = await apply.execute({ record_path: path.join(outside, 'record.json') }, { workingDir: workspace } as never);
      expect(result).toEqual({ content: expect.stringMatching(/^\[E_PATH_OUT_OF_SCOPE\]/), isError: true });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
