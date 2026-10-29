import { describe, expect, it } from 'vitest';
import { shouldUseRuntimeFollowup } from '../../../../src/main/features/cogseed_backend/followup-routing';

describe('CogSeed follow-up routing (owner principle)', () => {
  it('keeps a Group Chat-owned prior task with the Group Chat executor', () => {
    // Regression: a form/card turn leaves a group-chat projection task in
    // `waiting_user`. Treating that as a runtime pause resumed a task the
    // Runtime refuses to run, so the submitted answer became a failed turn.
    expect(shouldUseRuntimeFollowup({
      hasPriorTask: true,
      priorIsRuntimeOwned: false,
      implicitFloor: true,
    })).toBe(false);
  });

  it('continues a runtime-owned task in the Runtime', () => {
    expect(shouldUseRuntimeFollowup({
      hasPriorTask: true,
      priorIsRuntimeOwned: true,
      implicitFloor: false,
    })).toBe(true);
  });

  it('prefers the latest task owner over the implicit floor flag', () => {
    expect(shouldUseRuntimeFollowup({
      hasPriorTask: true,
      priorIsRuntimeOwned: false,
      implicitFloor: false,
    })).toBe(false);
    expect(shouldUseRuntimeFollowup({
      hasPriorTask: true,
      priorIsRuntimeOwned: true,
      implicitFloor: true,
    })).toBe(true);
  });

  it('keeps the legacy runtime path for a floor Agent without any task yet', () => {
    expect(shouldUseRuntimeFollowup({
      hasPriorTask: false,
      priorIsRuntimeOwned: false,
      implicitFloor: true,
    })).toBe(true);
  });

  it('dispatches normally when neither a task nor the floor selects the Agent', () => {
    expect(shouldUseRuntimeFollowup({
      hasPriorTask: false,
      priorIsRuntimeOwned: false,
      implicitFloor: false,
    })).toBe(false);
  });
});
