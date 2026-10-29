import { describe, expect, it } from 'vitest';

import { deriveArtifactIdentity, isMeetingArtifactName } from '../../../src/main/features/meeting_kb_precipitate';

const PREFIX = '2026-10-16_例会-P3394 Scrum Team_2110938132062334977';
const KEY = '2026-10-16-例会-P3394-Scrum-Team-2110938132062334977';

describe('meeting artifact identity', () => {
  it('maps the four standard names to one meeting key and distinct kinds', () => {
    expect(deriveArtifactIdentity(`/w/${PREFIX}_转写.md`)).toEqual({
      meetingKey: KEY, kind: 'transcript', version: '',
    });
    expect(deriveArtifactIdentity(`/w/${PREFIX}_转写-纠错.md`)).toEqual({
      meetingKey: KEY, kind: 'corrected_transcript', version: '',
    });
    expect(deriveArtifactIdentity(`/w/${PREFIX}_会议纪要_v001.md`)).toEqual({
      meetingKey: KEY, kind: 'minutes', version: 'v001',
    });
    expect(deriveArtifactIdentity(`/w/${PREFIX}_任务清单_v002.md`)).toEqual({
      meetingKey: KEY, kind: 'actions', version: 'v002',
    });
  });

  it('recognizes legacy separators without creating a second meeting key', () => {
    expect(deriveArtifactIdentity(`/w/${PREFIX}_转写_纠错稿.md`)).toEqual({
      meetingKey: KEY, kind: 'corrected_transcript', version: '',
    });
    expect(deriveArtifactIdentity(`/w/${PREFIX}_转写_纠错.md`)).toEqual({
      meetingKey: KEY, kind: 'corrected_transcript', version: '',
    });
    expect(deriveArtifactIdentity(`/w/${PREFIX}_原始转写.md`)).toEqual({
      meetingKey: KEY, kind: 'transcript', version: '',
    });
    expect(deriveArtifactIdentity(`/w/${PREFIX}_待办_v001.md`)).toEqual({
      meetingKey: KEY, kind: 'actions', version: 'v001',
    });
  });

  it('never treats a middle-segment word as the type suffix', () => {
    const identity = deriveArtifactIdentity('/w/2026-10-14_会议纪要模板_在线会议_v001.md');
    expect(identity.kind).toBe('minutes');
    expect(identity.version).toBe('v001');
    expect(identity.meetingKey).toContain('会议纪要模板');
  });
});

describe('meeting artifact name guard', () => {
  it('does not archive arbitrary skill outputs as meeting minutes', () => {
    for (const name of ['findings.json', 'findings-flat.csv', 'report.md', 'manifest-before.json', 'manifest-after.json', 'run.log']) {
      expect(isMeetingArtifactName(`/w/${name}`), name).toBe(false);
    }
  });

  it('still recognizes the four standard meeting artifact names', () => {
    for (const name of ['转写.md', '转写-纠错.md', '会议纪要_v001.md', '任务清单_v002.md']) {
      expect(isMeetingArtifactName(`/w/${PREFIX}_${name}`), name).toBe(true);
    }
  });
});
