import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMateOfficeAdapter } from '../../../../src/main/features/mate_agent_backend/office-adapter';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function root() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-office-')); dirs.push(dir); return dir; }

function setup() {
  const runOfficeCli = vi.fn(async (args: string[], opts: any) => {
    if (args[0] === 'create') fs.writeFileSync(args[1], 'created');
    if (args.includes('screenshot')) fs.writeFileSync(args[args.indexOf('-o') + 1], 'png');
    return { code: 0, stdout: args[0] === 'view' ? '[/body/p[1]] Hello' : '', stderr: '' };
  });
  const closeOfficeFile = vi.fn(async () => {});
  return { adapter: createMateOfficeAdapter({ officeCliAvailable: () => true, runOfficeCli, closeOfficeFile }), runOfficeCli, closeOfficeFile };
}

describe('Mate Office adapter', () => {
  it('reads only scoped Office files and always closes the resident', async () => {
    const dir = root(); const file = path.join(dir, 'a.docx'); fs.writeFileSync(file, 'x');
    const h = setup();
    await expect(h.adapter.run('office_read', { path: file }, { userId: 'u', requestId: 'req-a', runtimeSessionId: 'mruntime-a', readOnlyRoots: [dir], writableRoots: [] })).resolves.toMatchObject({ content: expect.stringContaining('Hello') });
    expect(h.closeOfficeFile).toHaveBeenCalledWith(file, dir);
    const denied = await h.adapter.run('office_read', { path: file }, { userId: 'u', requestId: 'req-a', runtimeSessionId: 'mruntime-a', readOnlyRoots: [], writableRoots: [] });
    expect(denied).toMatchObject({ isError: true, content: expect.stringContaining('E_PATH_OUT_OF_SCOPE') });
  });

  it('creates and edits with validated batch operations under a writable root', async () => {
    const dir = root(); const file = path.join(dir, 'a.xlsx'); const h = setup();
    const created = await h.adapter.run('office_create', { path: file, operations: [{ action: 'set', path: '/Sheet1/A1', props: { value: '42' } }], preview: false }, { userId: 'u', requestId: 'req-a', runtimeSessionId: 'mruntime-a', readOnlyRoots: [dir], writableRoots: [dir], workingDir: dir });
    expect(created.isError).toBeFalsy();
    expect(h.runOfficeCli).toHaveBeenNthCalledWith(1, ['create', file, '--force'], expect.objectContaining({ cwd: dir }));
    expect(h.runOfficeCli).toHaveBeenNthCalledWith(2, ['batch', file], expect.objectContaining({ stdin: JSON.stringify([{ command: 'set', path: '/Sheet1/A1', props: { value: '42' } }]) }));
    const bad = await h.adapter.run('office_edit', { path: file, operations: [{ action: 'set', path: '--save=/tmp/pwn', props: {} }] }, { userId: 'u', requestId: 'req-a', runtimeSessionId: 'mruntime-a', readOnlyRoots: [dir], writableRoots: [dir] });
    expect(bad).toMatchObject({ isError: true, content: expect.stringContaining('E_OFFICE_INPUT') });

    const external = await h.adapter.run('office_edit', { path: file, operations: [{ action: 'set', path: '/Sheet1/A1', props: { src: '/etc/passwd' } }] }, { userId: 'u', requestId: 'req-a', runtimeSessionId: 'mruntime-a', readOnlyRoots: [dir], writableRoots: [dir] });
    expect(external).toMatchObject({ isError: true, content: expect.stringContaining('external file') });
    const overwrite = await h.adapter.run('office_create', { path: file, operations: [{ action: 'set', path: '/Sheet1/A1', props: { value: 'x' } }] }, { userId: 'u', requestId: 'req-a', runtimeSessionId: 'mruntime-a', readOnlyRoots: [dir], writableRoots: [dir] });
    expect(overwrite).toMatchObject({ isError: true, content: expect.stringContaining('exists') });
  });

  it('reports missing engine without touching a file', async () => {
    const adapter = createMateOfficeAdapter({ officeCliAvailable: () => false, runOfficeCli: vi.fn(), closeOfficeFile: vi.fn() });
    await expect(adapter.run('office_read', { path: '/tmp/a.docx' }, { userId: 'u', requestId: 'req-a', runtimeSessionId: 'mruntime-a', readOnlyRoots: ['/tmp'], writableRoots: [] })).resolves.toMatchObject({ isError: true, content: expect.stringContaining('E_OFFICE_ENGINE_MISSING') });
  });
});
