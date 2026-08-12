import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let workspaceRoot: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-artifacts-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = workspaceRoot;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('Mate capability artifact lifecycle', () => {
  it('preserves the first artifact registered before a manifest exists', async () => {
    const { createMateCapabilityArtifactRegistry } = await import('../../../../src/main/features/cogseed_backend/capability-artifact-lifecycle');
    const registry = createMateCapabilityArtifactRegistry();
    const scope = { userId: 'artifact-user', runtimeSessionId: 'mruntime-artifacts' };

    const outputPath = path.join(workspaceRoot, 'report.docx');
    fs.writeFileSync(outputPath, 'docx');
    const output = await registry.register(scope, { kind: 'office-output', path: outputPath, owned: false });
    const previewPath = path.join(workspaceRoot, 'preview.png');
    fs.writeFileSync(previewPath, 'png');
    const preview = await registry.register(scope, { kind: 'office-preview', path: previewPath, owned: true });

    await expect(registry.list(scope)).resolves.toEqual([
      expect.objectContaining({ artifactId: output.artifactId, kind: 'office-output', owned: false }),
      expect.objectContaining({ artifactId: preview.artifactId, kind: 'office-preview', owned: true }),
    ]);

    await registry.cleanup(scope);
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.existsSync(previewPath)).toBe(false);
  });
});
