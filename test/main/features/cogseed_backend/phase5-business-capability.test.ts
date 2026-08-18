import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_A = 'phase5-user-a';
const USER_B = 'phase5-user-b';
let workspaceRoot: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-phase5-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = workspaceRoot;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

const transport = {
  kind: 'streamable-http' as const,
  url: 'https://mcp.example.test/mcp',
  headers: { Authorization: 'Bearer phase5-secret' },
};

function scope(userId = USER_A) {
  return {
    userId,
    requestId: 'req-phase5',
    runtimeSessionId: 'mruntime-phase5',
    actorId: 'gmember-phase5',
    sessionKind: 'gmember',
    readOnlyRoots: [] as string[],
    writableRoots: [] as string[],
  };
}

function fakeConnectorConnection(result: unknown = { ok: true }) {
  return {
    isConnected: false,
    connect: vi.fn(async function (this: { isConnected: boolean }) { this.isConnected = true; }),
    listTools: vi.fn(async () => [
      { name: 'search', description: 'Search', input_schema: { type: 'object' } },
      { name: 'delete', description: 'Delete', input_schema: { type: 'object' } },
    ]),
    callTool: vi.fn(async () => result),
    close: vi.fn(async () => undefined),
  };
}

function fakeVectorStore() {
  const indexed = new Map<string, string>();
  return {
    indexed,
    async vectorize(id: string, input: { buf: Buffer }) { indexed.set(id, input.buf.toString('utf8')); return 1; },
    async searchByQuery(query: string) {
      return Array.from(indexed.entries())
        .filter(([, content]) => content.includes(query))
        .map(([rel_path, content]) => ({ file_id: 1, rel_path, kind: 'text', chunk_idx: 0, title: rel_path, content, score: 1, distance: 0 }));
    },
    close() {},
  };
}

describe('Phase 5 business capability parity', () => {
  it('enforces connector actor/session scope and caps oversized connector results', async () => {
    const store = await import('../../../../src/main/features/cogseed_backend/connector-store');
    const { createCogSeedConnectorManager } = await import('../../../../src/main/features/cogseed_backend/connector-manager');
    const hidden = fakeConnectorConnection({ payload: 'x'.repeat(40_000) });
    await store.createCogSeedConnector(USER_A, { id: 'cogseed-connector-visible', displayName: 'Visible', transport });
    await store.createCogSeedConnector(USER_A, { id: 'cogseed-connector-hidden', displayName: 'Hidden', transport });
    const manager = createCogSeedConnectorManager({ connectionFactory: (id) => id.endsWith('visible') ? hidden : fakeConnectorConnection() });
    const capabilityScope = { userId: USER_A, actorId: 'gmember-phase5', sessionId: 'gconv-phase5', allowedConnectorIds: ['cogseed-connector-visible'] };

    await expect(manager.listAllTools(USER_A, { scope: capabilityScope })).resolves.toEqual([
      expect.objectContaining({ connectorId: 'cogseed-connector-visible', name: 'search' }),
      expect.objectContaining({ connectorId: 'cogseed-connector-visible', name: 'delete' }),
    ]);
    await expect(manager.callTool(USER_A, 'cogseed-connector-hidden', 'search', {}, { scope: capabilityScope })).rejects.toThrow(/scope|visible/i);
    const result = await manager.callTool(USER_A, 'cogseed-connector-visible', 'search', {}, { scope: capabilityScope });
    expect(result).toMatchObject({ truncated: true, tool: 'cogseed-connector-visible.search' });
    expect(String((result as { content?: string }).content)).toContain('[truncated]');
    expect(String((result as { content?: string }).content).length).toBeLessThan(25_000);
  });

  it('exposes KB list/search/read compatibility semantics with source scope and bounded chunks', async () => {
    const { createCogSeedKbManager } = await import('../../../../src/main/features/cogseed_backend/cogseed-kb-store');
    const manager = createCogSeedKbManager({ vectorStoreFactory: () => fakeVectorStore() });
    const content = `connector notes\n${'context '.repeat(1_000)}`;
    await manager.indexText(USER_A, { sourceId: 'cogseed-source-notes', title: 'Notes', content });
    const capabilityScope = { userId: USER_A, actorId: 'gmember-phase5', sessionId: 'gconv-phase5', allowedKbSourceIds: ['cogseed-source-notes'] };

    await expect(manager.list(USER_A, { scope: capabilityScope })).resolves.toEqual([
      expect.objectContaining({ scope: 'cogseed', path: 'cogseed-source-notes', status: 'ready', kind: 'text' }),
    ]);
    const search = await manager.searchCompatible(USER_A, { query: 'connector', scope: capabilityScope, maxChars: 120 });
    expect(search).toEqual([expect.objectContaining({ scope: 'cogseed', path: 'cogseed-source-notes', chunk: 0 })]);
    expect(String(search[0].content).length).toBeLessThanOrEqual(120);
    const read = await manager.readCompatible(USER_A, { path: 'cogseed-source-notes', chunk: 0, scope: capabilityScope, maxChars: 120 });
    expect(read).toMatchObject({ scope: 'cogseed', path: 'cogseed-source-notes', chunk: 0, totalChunks: expect.any(Number) });
    expect(read.content.length).toBeLessThanOrEqual(120);
    await expect(manager.readCompatible(USER_B, { path: 'cogseed-source-notes', scope: { userId: USER_B, allowedKbSourceIds: ['cogseed-source-notes'] } })).rejects.toThrow(/not found|scope/i);
  });

  it('provides specialized Office facades and registers created output plus previews', async () => {
    const { createCogSeedOfficeAdapter } = await import('../../../../src/main/features/cogseed_backend/office-adapter');
    const dir = fs.mkdtempSync(path.join(workspaceRoot, 'office-'));
    const runOfficeCli = vi.fn(async (args: string[], _opts: any) => {
      if (args[0] === 'create') fs.writeFileSync(args[1], 'created');
      if (args.includes('screenshot')) fs.writeFileSync(args[args.indexOf('-o') + 1], 'png');
      return { code: 0, stdout: args[0] === 'view' ? 'preview' : '', stderr: '' };
    });
    const adapter = createCogSeedOfficeAdapter({ officeCliAvailable: () => true, runOfficeCli, closeOfficeFile: vi.fn(async () => undefined) });
    const result = await adapter.createDocx({ path: path.join(dir, 'report.docx'), paragraphs: [{ text: 'Hello' }], preview: true }, { ...scope(), readOnlyRoots: [dir], writableRoots: [dir], workingDir: dir });
    expect(result.isError).toBeFalsy();
    expect(runOfficeCli).toHaveBeenCalledWith(['create', path.join(dir, 'report.docx'), '--force'], expect.anything());
    const parsed = JSON.parse(result.content);
    expect(parsed).toMatchObject({ artifactId: expect.any(String), previewArtifactId: expect.any(String) });
    expect(parsed.artifactId).toMatch(/^office-output-/);
    expect(parsed.previewArtifactId).toMatch(/^office-preview-/);
    const outputPath = path.join(dir, 'report.docx');
    expect(fs.existsSync(outputPath)).toBe(true);

    const { cogseedCapabilityArtifactRegistry } = await import('../../../../src/main/features/cogseed_backend/capability-artifact-lifecycle');
    const artifacts = await cogseedCapabilityArtifactRegistry.list({ userId: USER_A, runtimeSessionId: 'mruntime-phase5' });
    const outputArtifact = artifacts.find((artifact) => artifact.kind === 'office-output');
    const previewArtifact = artifacts.find((artifact) => artifact.kind === 'office-preview');
    expect(outputArtifact).toMatchObject({ artifactId: parsed.artifactId, path: outputPath, owned: false });
    expect(previewArtifact).toMatchObject({ artifactId: parsed.previewArtifactId, owned: true });
    expect(previewArtifact && fs.existsSync(previewArtifact.path)).toBe(true);

    await cogseedCapabilityArtifactRegistry.cleanup({ userId: USER_A, runtimeSessionId: 'mruntime-phase5' });
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(previewArtifact && fs.existsSync(previewArtifact.path)).toBe(false);
  });

  it('rejects unsafe post-click navigation and cleans auto browser artifacts on dispose', async () => {
    const { createCogSeedBrowserManager } = await import('../../../../src/main/features/cogseed_backend/browser-manager');
    const scripts: string[] = [];
    const win: any = {
      url: 'https://example.com', destroyed: false,
      async loadURL(url: string) { win.url = url; },
      getTitle: () => 'Example',
      webContents: {
        getURL: () => win.url,
        executeJavaScript: vi.fn(async (script: string) => {
          scripts.push(script);
          if (script.includes('__MATE_BROWSER_SNAPSHOT__')) return { url: win.url, title: 'Example', text: 'Hello', elements: [{ ref: 1, tag: 'button', role: 'button', label: 'Go' }] };
          if (script.includes('.click()')) return { ok: true, url: 'http://127.0.0.1/private', title: 'Private' };
          return { ok: true, url: win.url, title: 'Example' };
        }),
        capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from('png') })),
        session: { webRequest: { onBeforeRequest: vi.fn() } },
        setWindowOpenHandler: vi.fn(), on: vi.fn(), stop: vi.fn(),
      },
      isDestroyed: () => win.destroyed,
      destroy: vi.fn(() => { win.destroyed = true; }),
    };
    const manager = createCogSeedBrowserManager({ createWindow: vi.fn(() => win) });
    const browserScope = { ...scope(), writableRoots: [], readOnlyRoots: [] };
    await manager.open(browserScope, 'https://example.com');
    await manager.snapshot(browserScope);
    await expect(manager.click(browserScope, 1)).resolves.toMatchObject({ isError: true, content: expect.stringContaining('E_BROWSER_URL') });
    expect(win.destroy).toHaveBeenCalled();

    win.destroyed = false;
    await manager.open(browserScope, 'https://example.com');
    const screenshot = await manager.screenshot(browserScope);
    const screenshotPath = JSON.parse(screenshot.content).path;
    expect(fs.existsSync(screenshotPath)).toBe(true);
    const parsed = JSON.parse(screenshot.content);
    expect(parsed.artifactId).toMatch(/^browser-screenshot-/);
    await manager.dispose(browserScope.userId, browserScope.runtimeSessionId);
    expect(fs.existsSync(screenshotPath)).toBe(false);
  });
});
