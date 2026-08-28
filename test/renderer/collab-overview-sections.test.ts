import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * COGSEED-61 renderer contract tests for the local group-chat collaboration
 * overview sections (task breakdown / handoffs / anomalies / summary).
 *
 * Static source contracts (same style as collaboration-overview-drawer.test.ts):
 * the render helpers live in a closure, so we assert on the source wiring —
 * helper presence, structured-field passthrough, css class names and the
 * locale keys every section reads.
 */

const infoSource = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/conversation-info.js'),
  'utf8',
);
const conversationSource = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);

describe('local collab overview sections (conversation-info)', () => {
  it('defines the four local collab section renderers', () => {
    for (const helper of [
      '_renderLocalCollabTaskSection',
      '_renderLocalCollabHandoffSection',
      '_renderLocalCollabAnomalySection',
      '_renderLocalCollabSummarySection',
    ]) {
      expect(infoSource).toContain(`function ${helper}`);
    }
  });

  it('loads the overview projection alongside members and runtime', () => {
    expect(infoSource).toContain("collaboration/overview`");
    expect(infoSource).toContain('collabOverview: collabOverviewRes && collabOverviewRes.overview ? collabOverviewRes.overview : null');
    expect(infoSource).toContain('collabOverview: null');
  });

  it('mounts local sections between the cloud overview and the agent activity', () => {
    expect(infoSource).toContain('localTaskHtml}${localHandoffHtml}${localAnomalyHtml}${localSummaryHtml}');
  });

  it('task breakdown shows objective, per-step dependency notes and retry badges', () => {
    expect(infoSource).toContain('conversation_info.collaboration.section_task_breakdown');
    expect(infoSource).toContain('depends_on');
    expect(infoSource).toContain('retry_count');
    expect(infoSource).toContain('steps_progress');
    expect(infoSource).toContain('conversation-info-collab-step-dot');
  });

  it('handoff section labels dispatch/handback and lists recovered outputs', () => {
    expect(infoSource).toContain('handoff.dispatch');
    expect(infoSource).toContain('handoff.handback');
    expect(infoSource).toContain('recovered_outputs');
  });

  it('anomaly section covers failure/retry/cancel/degraded with impact', () => {
    for (const kind of ['failure', 'retry', 'cancel', 'degraded']) {
      expect(infoSource).toContain(`anomaly.${kind}`);
    }
    expect(infoSource).toContain('anomaly.impact');
    expect(infoSource).toContain('item.impact.join');
  });

  it('summary section renders conclusion, contributions and final result', () => {
    expect(infoSource).toContain('summary.all_done');
    expect(infoSource).toContain('summary.cancelled');
    expect(infoSource).toContain('summary.steps_done');
    expect(infoSource).toContain('summary.final_result');
  });

  it('empty state also accounts for a local run being present', () => {
    expect(infoSource).toContain('!hasLocalRun');
  });
});

describe('chat collab summary card (conversation.js)', () => {
  it('passes the structured summary field through message preprocessing', () => {
    expect(conversationSource).toContain('...(gm.collab_summary ? { collab_summary: gm.collab_summary } : {})');
  });

  it('renders the details card with conclusion chip, contributions and final result', () => {
    expect(conversationSource).toContain('chat-collab-summary');
    expect(conversationSource).toContain("t('chat.collab_summary.title')");
    expect(conversationSource).toContain('chat.collab_summary.count');
    expect(conversationSource).toContain('chat.collab_summary.steps_done');
    expect(conversationSource).toContain('collabSummaryHead}${p3394BadgeHtml}');
  });
});

describe('local collab overview locale contract', () => {
  const requiredKeys = [
    'conversation_info.collaboration.section_task_breakdown',
    'conversation_info.collaboration.section_handoffs',
    'conversation_info.collaboration.section_anomalies',
    'conversation_info.collaboration.section_summary',
    'conversation_info.collaboration.steps_progress',
    'conversation_info.collaboration.run_status.running',
    'conversation_info.collaboration.run_status.cancelled',
    'conversation_info.collaboration.retry_count',
    'conversation_info.collaboration.depends_on',
    'conversation_info.collaboration.state_running',
    'conversation_info.collaboration.state_pending',
    'conversation_info.collaboration.state_failed',
    'conversation_info.collaboration.state_skipped',
    'conversation_info.collaboration.handoff.dispatch',
    'conversation_info.collaboration.handoff.handback',
    'conversation_info.collaboration.handoff.context_update',
    'conversation_info.collaboration.handoff.context_target',
    'conversation_info.collaboration.recovered_outputs',
    'conversation_info.collaboration.anomaly.failure',
    'conversation_info.collaboration.anomaly.retry',
    'conversation_info.collaboration.anomaly.cancel',
    'conversation_info.collaboration.anomaly.degraded',
    'conversation_info.collaboration.anomaly.impact',
    'conversation_info.collaboration.summary.all_done',
    'conversation_info.collaboration.summary.cancelled',
    'conversation_info.collaboration.summary.failed',
    'conversation_info.collaboration.summary.steps_done',
    'conversation_info.collaboration.summary.retries',
    'conversation_info.collaboration.summary.files',
    'chat.collab_summary.title',
    'chat.collab_summary.all_done',
    'chat.collab_summary.cancelled',
    'chat.collab_summary.failed',
    'chat.collab_summary.count',
    'chat.collab_summary.steps_done',
    'chat.collab_summary.retries',
    'chat.collab_summary.files',
  ];

  it.each(['en', 'zh', 'ja', 'pt'])('defines all collab overview keys in %s', (locale) => {
    const data = JSON.parse(readFileSync(resolve(__dirname, `../../src/renderer/locales/${locale}.json`), 'utf8'));
    for (const key of requiredKeys) {
      expect(data[key], `${locale} missing ${key}`).toBeTruthy();
    }
    expect(data['conversation_info.collaboration.steps_progress']).toContain('{completed}');
    expect(data['conversation_info.collaboration.steps_progress']).toContain('{total}');
    expect(data['chat.collab_summary.count']).toContain('{total}');
  });
});
