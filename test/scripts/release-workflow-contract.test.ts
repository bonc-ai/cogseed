import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflowsDir = path.resolve('.github/workflows');

function load(name: string): any {
  return parse(fs.readFileSync(path.join(workflowsDir, name), 'utf8'), { version: '1.2' });
}

function steps(job: any): any[] {
  return Array.isArray(job?.steps) ? job.steps : [];
}

function commands(job: any): string {
  return steps(job).map((step) => step.run ?? '').join('\n');
}

function isWorkflowFile(name: string): boolean {
  return name.endsWith('.yml') || name.endsWith('.yaml');
}

describe('release workflow contract', () => {
  it('discovers both .yml and .yaml workflow files', () => {
    expect(['a.yml', 'b.yaml', 'notes.md'].filter(isWorkflowFile)).toEqual(['a.yml', 'b.yaml']);
  });

  it.each(['ci.yml', 'compliance.yml'])('%s runs automatically only for cicd PRs and pushes', (name) => {
    const workflow = load(name);
    expect(workflow.on).toEqual({
      pull_request: { branches: ['cicd'] },
      push: { branches: ['cicd'] },
    });
  });

  it('keeps the CI job names exact and makes the Windows gate complete', () => {
    const workflow = load('ci.yml');
    expect(Object.keys(workflow.jobs).sort()).toEqual(['verify', 'verify-windows']);
    const windows = commands(workflow.jobs['verify-windows']);
    for (const expected of [
      'npm run lint',
      'node scripts/run-tests.mjs run --maxWorkers=1',
      'npm run test:resources',
      'npm run test:platform-native',
      'node p3394-gateway/test/smoke.cjs',
      'npm run build:win',
    ]) expect(windows).toContain(expected);
  });

  it('keeps compliance to its one required job', () => {
    expect(Object.keys(load('compliance.yml').jobs)).toEqual(['compliance']);
  });

  it('triggers the release workflow only for v* tags', () => {
    const workflow = load('release.yml');
    expect(workflow.on).toEqual({ push: { tags: ['v*'] } });
    expect(workflow.permissions).toEqual({ actions: 'read', contents: 'read' });
    expect(workflow.concurrency).toEqual({
      group: 'release-${{ github.ref }}',
      'cancel-in-progress': false,
    });
  });

  it('uses gate -> two builds -> one publisher and checks out the peeled SHA', () => {
    const workflow = load('release.yml');
    expect(Object.keys(workflow.jobs).sort()).toEqual(['build-macos', 'build-windows', 'gate', 'publish']);
    expect(workflow.jobs.gate.outputs['peeled-sha']).toContain('steps.verify.outputs.peeled-sha');
    for (const name of ['build-macos', 'build-windows']) {
      expect(workflow.jobs[name].needs).toBe('gate');
      const checkout = steps(workflow.jobs[name]).find((step) => step.uses === 'actions/checkout@v4');
      expect(checkout?.with?.ref).toBe('${{ needs.gate.outputs.peeled-sha }}');
      expect(steps(workflow.jobs[name]).some((step) => step.uses === 'actions/upload-artifact@v4')).toBe(true);
    }
    expect(workflow.jobs.publish.needs).toEqual(['gate', 'build-macos', 'build-windows']);
  });

  it('grants contents: write only to the sole publisher and has one Release action repository-wide', () => {
    const files = fs.readdirSync(workflowsDir).filter(isWorkflowFile);
    const releaseActions: Array<{ file: string; job: string }> = [];
    const writers: Array<{ file: string; job: string }> = [];
    for (const file of files) {
      const workflow = load(file);
      for (const [jobName, job] of Object.entries<any>(workflow.jobs ?? {})) {
        if (job?.permissions?.contents === 'write') writers.push({ file, job: jobName });
        for (const step of steps(job)) {
          if (String(step.uses ?? '').startsWith('softprops/action-gh-release@')) releaseActions.push({ file, job: jobName });
        }
      }
      expect(workflow.permissions?.contents).not.toBe('write');
    }
    expect(writers).toEqual([{ file: 'release.yml', job: 'publish' }]);
    expect(releaseActions).toEqual([{ file: 'release.yml', job: 'publish' }]);
    expect(load('release.yml').jobs.publish.permissions).toEqual({ actions: 'read', contents: 'write' });
  });

  it('checks the remote tag and existing Release before the sole pinned publisher action', () => {
    const workflow = load('release.yml');
    const publishSteps = steps(workflow.jobs.publish);
    const preflightIndex = publishSteps.findIndex((step) => String(step.run ?? '').includes('--publish-target'));
    const artifactValidationIndex = publishSteps.findIndex((step) => step.name === 'Validate release artifact set');
    const releaseIndex = publishSteps.findIndex((step) => String(step.uses ?? '').startsWith('softprops/action-gh-release@'));
    expect(preflightIndex).toBeGreaterThanOrEqual(0);
    expect(preflightIndex).toBeGreaterThan(artifactValidationIndex);
    expect(preflightIndex).toBe(releaseIndex - 1);
    expect(publishSteps[preflightIndex].env.EXPECTED_SHA).toBe('${{ needs.gate.outputs.peeled-sha }}');
    expect(publishSteps[releaseIndex].uses).toBe('softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65');
    const source = fs.readFileSync(path.join(workflowsDir, 'release.yml'), 'utf8');
    expect(source).toContain('softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65 # v2');
  });

  it('makes the publisher validate exactly four mac files and one win-x64 exe before publishing the draft', () => {
    const publish = load('release.yml').jobs.publish;
    const script = commands(publish);
    expect(script).toContain('expected_files');
    for (const suffix of ['mac-arm64.dmg', 'mac-arm64.zip', 'mac-x64.dmg', 'mac-x64.zip', 'win-x64.exe']) {
      expect(script).toContain(suffix);
    }
    const action = steps(publish).find((step) => String(step.uses ?? '').startsWith('softprops/action-gh-release@'));
    expect(action.with.draft).toBe(true);
    expect(script).toContain('draft=false');
  });

  it('leaves the legacy mac workflow manual, read-only, and release-free', () => {
    const legacy = load('build-macos-signed.yml');
    expect(legacy.on).toEqual({ workflow_dispatch: null });
    expect(legacy.permissions).toEqual({ contents: 'read' });
    expect(JSON.stringify(legacy)).not.toContain('action-gh-release');
  });
});
