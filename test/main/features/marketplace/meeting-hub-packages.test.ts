import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { buildMeetingHubPackages, type HubSkillBindings } from '../../../../scripts/build-meeting-hub-packages';
import { readAgentPackage } from '../../../../src/main/features/marketplace/agent-package';
import { planAgentDependencies } from '../../../../src/main/features/marketplace_agent_deps';
import { isBundledAgentId, isBundledSkillId } from '../../../../src/main/features/builtin_bundled';

const root = path.resolve(__dirname, '../../../../distribution/meeting');
const bindings: HubSkillBindings = {
  hub_origin: 'https://hub.test',
  skills: {
    'meeting-minutes': { content_id: '123456abcdef', version: '1.0.0' },
    'meeting-task-breakdown': { content_id: '234567abcdef', version: '1.0.0' },
  },
};

describe('meeting new-content Hub distribution', () => {
  it('withholds the Agent until target-Hub Skill IDs exist, and preserves complete independent Skill trees', () => {
    const { archives } = buildMeetingHubPackages(root);
    expect(archives.map((item) => item.kind)).toEqual(['skill', 'skill']);
    for (const skill of archives) {
      expect(skill).not.toHaveProperty('content_id');
      const zip = new AdmZip(skill.bytes);
      for (const file of ['SKILL.md', 'schemas.json', 'references/input-contract.md', 'references/output-contract.md', 'evals/evals.json']) {
        expect(zip.readFile(file)).toEqual(fs.readFileSync(path.join(root, 'skills', skill.source_key, file)));
      }
    }
    expect(isBundledAgentId('f5bba047480f')).toBe(false);
    expect(isBundledSkillId('c02aa1c0e17c')).toBe(false);
    expect(isBundledSkillId('6d16836d5c25')).toBe(false);
  });

  it('binds only actual Hub refs; publication and installation assign the new Agent identity', () => {
    const { release, archives } = buildMeetingHubPackages(root, bindings);
    const zip = new AdmZip(archives.find((item) => item.kind === 'agent')!.bytes);
    expect(zip.getEntries().map((entry) => entry.entryName)).toEqual(['agent.json']);
    const author = JSON.parse(zip.readAsText('agent.json'));
    for (const key of ['agent_id', 'version', 'created_at', 'updated_at', 'enabled_connectors']) expect(author).not.toHaveProperty(key);
    zip.addFile('_meta.json', Buffer.from(JSON.stringify({ version: release.agent.version, published_at: '2026-10-28T00:00:00Z' })));
    const installed = readAgentPackage(zip.toBuffer(), { expectedVersion: release.agent.version, installedAgentId: '345678abcdef' });
    expect(installed.agentJson.agent_id).toBe('345678abcdef');
    expect(installed.privateSkills).toBeNull();
    const refs = installed.agentJson.skill_list as string[];
    expect(refs).toEqual(Object.values(bindings.skills).map((ref) => ref.content_id));
    expect(planAgentDependencies(refs, new Set(), () => ({ present: false, disabled: false })).toInstall).toEqual(refs);
    expect(planAgentDependencies(refs, new Set(), () => ({ present: true, disabled: true })).blocked).toHaveLength(2);
    expect(buildMeetingHubPackages(root, bindings).archives.map((item) => item.sha256)).toEqual(archives.map((item) => item.sha256));
  });

  it.each([
    { hub_origin: 'https://hub.test', skills: {} },
    { ...bindings, skills: { ...bindings.skills, 'meeting-minutes': { content_id: 'meeting-minutes', version: '1.0.0' } } },
    { ...bindings, skills: { ...bindings.skills, 'meeting-minutes': bindings.skills['meeting-task-breakdown'] } },
  ])('rejects incomplete, symbolic or duplicate bindings instead of emitting a broken Agent', (bad) => {
    expect(() => buildMeetingHubPackages(root, bad)).toThrow();
  });
});
