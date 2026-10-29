import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('候选转本体新写入口退役', () => {
  it('候选交接写服务已删除且IPC不再注册两个写入口', () => {
    expect(existsSync(resolve(__dirname, '../../../src/main/features/cognition/ontology/candidate-handoff.ts'))).toBe(false);
    const ipc = readFileSync(resolve(__dirname, '../../../src/main/ipc/cognition.ts'), 'utf8');
    expect(ipc).not.toContain('cognition.ontology.candidate.commit');
    expect(ipc).not.toContain('cognition.ontology.candidate.complete');
  });
  it('候选页不提供整理写动作，已integrated历史记录仍可打开', () => {
    const page = readFileSync(resolve(__dirname, '../../../src/renderer/modules/cognition-assets/review-candidate.js'), 'utf8');
    expect(page).not.toContain('cand-organize-ontology');
    expect(page).toContain("'open-ontology'");
    const workspace = readFileSync(resolve(__dirname, '../../../src/renderer/modules/cognition-ontology.js'), 'utf8');
    expect(workspace).not.toContain('cognition.ontology.candidate.commit');
    expect(workspace).not.toContain('cognition.ontology.candidate.complete');
  });
});
