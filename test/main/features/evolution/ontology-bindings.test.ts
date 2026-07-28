import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  bindOntology, unbindOntology, listOntologyBindings,
} from '../../../../src/main/features/evolution/ontology-bindings';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'onto-bind-'));
  process.env.ORKAS_WORKSPACE_ROOT = dir;
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); delete process.env.ORKAS_WORKSPACE_ROOT; });

describe('ontology-bindings', () => {
  it('未绑定时列表为空', async () => {
    expect(await listOntologyBindings('u1', 'sk1')).toEqual([]);
  });

  it('bindOntology 追加且去重', async () => {
    await bindOntology('u1', 'sk1', 'onto-a');
    await bindOntology('u1', 'sk1', 'onto-a'); // 重复
    await bindOntology('u1', 'sk1', 'onto-b');
    expect((await listOntologyBindings('u1', 'sk1')).sort()).toEqual(['onto-a', 'onto-b']);
  });

  it('unbindOntology 移除指定项', async () => {
    await bindOntology('u1', 'sk1', 'onto-a');
    await bindOntology('u1', 'sk1', 'onto-b');
    await unbindOntology('u1', 'sk1', 'onto-a');
    expect(await listOntologyBindings('u1', 'sk1')).toEqual(['onto-b']);
  });

  it('落盘位置在 cloud/skills/<id>/ontology/_bindings.json', async () => {
    await bindOntology('u1', 'sk1', 'onto-a');
    const p = path.join(dir, 'u1', 'cloud', 'skills', 'sk1', 'ontology', '_bindings.json');
    const raw = JSON.parse(await fs.readFile(p, 'utf-8'));
    expect(raw).toEqual(['onto-a']);
  });
});
