/**
 * REAL recommendation smoke test (gated). Runs recommendStartingPoint()
 * against the actual sessions on this machine and prints the ranked result
 * so we can eyeball that the "复杂项目" pick + template suggestion are real,
 * not fabricated. Gated behind COGSEED_WORKBUDDY_LIVE=1 (reuses the same flag
 * as the WorkBuddy live smoke, since both need real on-disk sessions).
 */
import { describe, it, expect } from 'vitest';

const LIVE = process.env.COGSEED_WORKBUDDY_LIVE === '1';
const d = LIVE ? describe : describe.skip;

d('recommendStartingPoint — real ranking on this machine', () => {
  it('ranks real sessions across agents and suggests a template from real text', async () => {
    const { recommendStartingPoint } = await import(
      '../../../../src/main/features/session_import/recommend-start'
    );
    const res = await recommendStartingPoint();
    // eslint-disable-next-line no-console
    console.log('[live] recommendStartingPoint =>', JSON.stringify({
      candidateCount: res.candidateCount,
      perSource: res.perSource,
      top: res.top && {
        source: res.top.source,
        sessionId: res.top.sessionId,
        projectPath: res.top.projectPath,
        firstMessage: (res.top.firstMessage || '').slice(0, 60),
        contextLength: res.top.contextLength,
        timestamp: res.top.timestamp,
        score: Number(res.top.score.toFixed(3)),
      },
      suggestedTemplate: res.suggestedTemplate,
    }, null, 2));

    // Structural guarantees (no fabrication): result is always well-formed.
    expect(typeof res.candidateCount).toBe('number');
    expect(res.perSource).toBeTruthy();
    if (res.top) {
      expect(res.top.contextLength).toBeGreaterThanOrEqual(0);
      expect(res.top.score).toBeGreaterThanOrEqual(0);
      expect(res.top.score).toBeLessThanOrEqual(1);
      expect(['claude', 'workbuddy', 'codex', 'opencode']).toContain(res.top.source);
    }
    if (res.suggestedTemplate) {
      // A suggestion must be backed by real matched keywords, never empty.
      expect(res.suggestedTemplate.matchedKeywords.length).toBeGreaterThan(0);
      expect(res.suggestedTemplate.score).toBeGreaterThanOrEqual(2);
    }
  }, 60_000);
});
