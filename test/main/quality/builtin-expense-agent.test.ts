import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { validateAgentDir } from '../../../src/main/quality';

const AGENT_DIR = path.resolve(
  __dirname,
  '../../../resources/builtin/marketplace/agents/c045605cb916',
);
const AGENT_ID = 'c045605cb916';

function readSpec(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(AGENT_DIR, 'agent.json'), 'utf8')) as Record<string, unknown>;
}

describe('builtin marketplace > reimbursement agent', () => {
  it('declares the secure Feishu setup and current-chat reimbursement workflow', () => {
    const spec = readSpec();
    expect(spec.agent_id).toBe(AGENT_ID);
    expect(spec.management_surface).toBe('expense_workbench');
    expect(spec.reimbursement_entry_role).toBe('canonical');
    expect(spec.interaction_mode).toBeUndefined();
    expect(spec.workflow).toContain('expense_configuration_status');
    expect(spec.workflow).toContain('<expense-setup-form />');
    expect(spec.workflow).toContain('current conversation');
    expect(spec.workflow).not.toMatch(/localhost|127\.0\.0\.1|task_agent\.py|stdio process|\.env|project directory/i);
    expect(spec.skill_list).toEqual([]);
  });

  it('runs in process and keeps human gates explicit', () => {
    const spec = readSpec();
    expect(spec.runtime).toEqual({ kind: 'in_process' });
    expect(spec.output_format).toBe('markdown');
    expect(spec.interactive).toBe(true);
    expect(spec.workflow).toMatch(/native confirmation/i);
    expect(spec.standards).toEqual(expect.arrayContaining([
      expect.stringMatching(/never represents a case as submitted/i),
    ]));
  });

  it('passes the agent quality gate without extreme violations', () => {
    const report = validateAgentDir(AGENT_DIR, { enforceSkillRunner: true });
    expect(report.ok).toBe(true);
    expect(report.violations.filter((v) => v.level === 'EXTREME')).toEqual([]);
  });
});
