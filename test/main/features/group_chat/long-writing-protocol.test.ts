import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../../');

function readPrompt(name: string): string {
  return fs.readFileSync(path.join(ROOT, 'src/main/prompts', name), 'utf8');
}

describe('group chat long writing protocol', () => {
  it('teaches every agent to split long write_file work across turns', () => {
    const prompt = readPrompt('chat_agent_in_group.md');
    expect(prompt).toContain('Chunked writing protocol');
    expect(prompt).toContain('one chunk per turn');
    expect(prompt).toContain('write_file.content');
    expect(prompt).toContain('6000 characters');
  });

  it('teaches the commander to schedule long writing as multiple small agent turns', () => {
    const prompt = readPrompt('chat_commander.md');
    expect(prompt).toContain('Chunked writing protocol');
    expect(prompt).toContain('multiple small turns');
    expect(prompt).toContain('one chunk per turn');
    expect(prompt).toContain('merge');
  });

  it('teaches the commander to make per-delegation KSTAR decisions', () => {
    const prompt = readPrompt('chat_commander.md');
    expect(prompt).toContain('KSTAR decision for delegated work');
    expect(prompt).toContain('kstar: "required" | "skip"');
    expect(prompt).toContain('kstar_expectation');
    expect(prompt).toContain('understood task, expected result, and execution plan');
    expect(prompt).toContain('task / expected result / plan');
    expect(prompt).toContain('not a user confirmation step');
    expect(prompt).toContain('action_hat');
    expect(prompt).toContain('result_hat');
    expect(prompt).toContain('R̂ is chat-only');
  });

});
