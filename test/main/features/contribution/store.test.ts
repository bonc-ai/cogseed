import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root = '';
vi.mock('../../../../src/main/paths', () => ({ userLocalRoot: (uid: string) => path.join(root, uid, 'local') }));

import {
  contributionTarget, localSkillUuid, mergeMine, readContributionStore,
} from '../../../../src/main/features/contribution/store';

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'contribution-store-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('account-partitioned contribution store', () => {
  it('keeps account rows and stable local ids isolated without persisting account ids', () => {
    mergeMine('uid', 'account-a', { generated_at: '2026-09-25T00:00:00Z', items: [{ entry_id: 'a', name: 'A' }] });
    mergeMine('uid', 'account-b', { generated_at: '2026-09-25T00:00:01Z', items: [{ entry_id: 'b', name: 'B' }] });
    expect(Object.keys(readContributionStore('uid', 'account-a').items)).toEqual(['a']);
    expect(Object.keys(readContributionStore('uid', 'account-b').items)).toEqual(['b']);
    expect(localSkillUuid('uid', 'account-a', 'skill')).toBe(localSkillUuid('uid', 'account-a', 'skill'));
    expect(localSkillUuid('uid', 'account-a', 'skill')).not.toBe(localSkillUuid('uid', 'account-b', 'skill'));
    const disk = fs.readdirSync(path.join(root, 'uid', 'local', 'hub-contributions'))
      .map((name) => fs.readFileSync(path.join(root, 'uid', 'local', 'hub-contributions', name), 'utf8')).join('');
    expect(disk).not.toContain('account-a');
    expect(disk).not.toContain('account-b');
    expect(disk).not.toMatch(/access[_-]?token|bearer/i);
  });

  it('merges incremental rows by entry_id and exposes target version/origin', () => {
    mergeMine('uid', 'account', { generated_at: 'one', items: [{ entry_id: 'content', content_id: 'content', name: 'Old', current_published_version: '1.0.0' }] });
    mergeMine('uid', 'account', { generated_at: 'two', items: [{ entry_id: 'content', content_id: 'content', name: 'New', current_published_version: '1.2.0', latest_submission: { submission_id: 'sub_1', status: 'PENDING_REVIEW', declarations_origin: { type: 'original' } } }] });
    expect(readContributionStore('uid', 'account').items.content).toMatchObject({ name: 'New' });
    expect(contributionTarget('uid', 'account', 'content')).toEqual({ currentVersion: '1.2.0', origin: { type: 'original' }, pendingSubmissionId: 'sub_1' });
  });

  it('replaces a cached submission row when Hub promotes it to a content row', () => {
    mergeMine('uid', 'account', {
      generated_at: 'one',
      items: [
        {
          entry_id: 'sub_accepted',
          updated_at: '2026-09-29T03:40:00Z',
          latest_submission: { submission_id: 'sub_accepted', status: 'PENDING_REVIEW' },
        },
        {
          entry_id: 'sub_withdrawn',
          updated_at: '2026-09-29T03:39:00Z',
          latest_submission: { submission_id: 'sub_withdrawn', status: 'WITHDRAWN' },
        },
      ],
    });

    const store = mergeMine('uid', 'account', {
      generated_at: 'two',
      items: [{
        entry_id: 'content_accepted',
        content_id: 'content_accepted',
        current_published_version: '1.0.0',
        updated_at: '2026-09-29T03:45:00Z',
        latest_submission: { submission_id: 'sub_accepted', status: 'ACCEPTED' },
      }],
    });

    expect(store.items.sub_accepted).toBeUndefined();
    expect(store.items.content_accepted).toMatchObject({
      current_published_version: '1.0.0',
      latest_submission: { submission_id: 'sub_accepted', status: 'ACCEPTED' },
    });
    expect(store.items.sub_withdrawn).toBeDefined();
  });

  it('discards incompatible or corrupt cache files', () => {
    localSkillUuid('uid', 'account', 'skill');
    const dir = path.join(root, 'uid', 'local', 'hub-contributions');
    const file = path.join(dir, fs.readdirSync(dir)[0]);
    fs.writeFileSync(file, '{"schema_version":999}');
    expect(readContributionStore('uid', 'account').items).toEqual({});
    fs.writeFileSync(file, 'not-json');
    expect(readContributionStore('uid', 'account').items).toEqual({});
  });

  it('drops malformed rows and bounds the machine-private cache', () => {
    const items = Array.from({ length: 520 }, (_, i) => ({
      entry_id: `entry_${i}`,
      updated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }));
    items.push({ entry_id: '../escape', updated_at: '2099-01-01T00:00:00Z' });
    const store = mergeMine('uid', 'account', { generated_at: 'bounded', items });
    expect(Object.keys(store.items)).toHaveLength(500);
    expect(store.items['../escape']).toBeUndefined();
    expect(store.items.entry_519).toBeDefined();
    expect(store.items.entry_0).toBeUndefined();
  });
});
