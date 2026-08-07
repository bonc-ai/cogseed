import { describe, expect, it } from 'vitest';

import {
  buildGconvSessionId,
  buildGmemberSessionId,
} from '../../../../src/main/features/group_chat/state';
import { resolveRecipients } from '../../../../src/main/features/group_chat/router';
import {
  resolveMateSessionIdentity,
} from '../../../../src/main/features/mate_agent_backend/actor-session-facade';

describe('group_chat / Mate Phase 1 session compatibility', () => {
  it('keeps gconv/gmember public session shapes while resolving Mate-owned storage identities', () => {
    const gconv = buildGconvSessionId('conversation-compat');
    const gmember = buildGmemberSessionId('conversation-compat', 'writer');

    expect(gconv).toBe('gconv-conversation-compat');
    expect(gmember).toBe('gmember-conversation-compat-writer');
    expect(resolveMateSessionIdentity(gconv)).toMatchObject({
      canonicalSessionId: 'mate-session-gconv-conversation-compat',
      actorRole: 'commander',
    });
    expect(resolveMateSessionIdentity(gmember)).toMatchObject({
      canonicalSessionId: 'mate-session-gmember-conversation-compat-writer',
      actorRole: 'member',
      actorId: 'writer',
    });
  });

  it('preserves existing mention routing semantics at the compatibility boundary', () => {
    expect(resolveRecipients({
      fromKind: 'user',
      fromId: 'user',
      text: '@Writer please review this',
      members: [
        { kind: 'commander', id: 'commander', name: 'Commander', joined_at: 't' },
        { kind: 'user', id: 'user', name: 'User', joined_at: 't' },
        { kind: 'agent', id: 'writer', name: 'Writer', joined_at: 't' },
      ],
    })).toEqual({ to: ['writer'], unknown: [] });
  });
});
