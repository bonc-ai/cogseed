import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

const legacyBackendFiles = [
  'src/main/features/p3394/ability-assets.ts',
  'src/main/features/p3394/ability-asset-store.ts',
  'src/main/features/p3394/kstar-adapter.ts',
  'src/main/features/p3394/kstar-bus-integration.ts',
  'src/main/features/p3394/kstar-compat.ts',
  'src/main/features/p3394/kstar-factory.ts',
  'src/main/features/p3394/kstar-kb.ts',
  'src/main/features/p3394/kstar-legacy-data.ts',
  'src/main/features/p3394/kstar-lock.ts',
  'src/main/features/p3394/kstar-migration.ts',
  'src/main/features/p3394/kstar-notion.ts',
  'src/main/features/p3394/kstar-recovery.ts',
  'src/main/features/p3394/kstar-store.ts',
];

const legacyChannels = [
  'p3394.listKstarCompatProjections',
  'p3394.reviewKstarCompatProjection',
  'p3394.decideExperienceCandidate',
  'p3394.syncExperienceCandidateToNotion',
  'p3394.listArchives',
  'p3394.readArchive',
  'p3394.checkMigrationStatus',
];

const legacyRendererSymbols = [
  '_renderKStarReviewCard',
  '_mountKStarReviewCard',
  '_resolveKStarReview',
  '_hydrateKStarReviews',
  '_resolveExperienceCandidate',
  '_syncExperienceCandidateToNotion',
  'data-kstar-run-id',
  'p3394.kstar.',
  'p3394.experience.',
];

describe('legacy P3394 KSTAR is deleted', () => {
  it('removes the backend subsystem while retaining canonical KSTAR', () => {
    for (const relative of legacyBackendFiles) {
      expect(fs.existsSync(path.join(root, relative)), `${relative} must be deleted`).toBe(false);
    }
    expect(fs.existsSync(path.join(root, 'src/main/features/kstar/task-closure.ts'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'src/main/features/kstar/requirement-closure.ts'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'src/main/features/kstar/recall-bridge.ts'))).toBe(true);
  });

  it('removes legacy IPC and renderer shim routes', () => {
    const ipc = read('src/main/ipc/index.ts');
    const shim = read('src/renderer/modules/ipc-shim.js');
    for (const channel of legacyChannels) {
      expect(ipc, `${channel} must not be registered`).not.toContain(channel);
      expect(shim, `${channel} must not be routed`).not.toContain(channel);
    }
    expect(shim).not.toMatch(/\/api\/conversations\/.*\/(?:kstar|experience)/);
  });

  it('removes the legacy review protocol and UI while retaining the canonical review card', () => {
    const visibility = read('src/main/features/group_chat/visibility.ts');
    const conversation = read('src/renderer/modules/conversation.js');
    expect(visibility).not.toMatch(/\bkstar_review\??\s*:/);
    expect(visibility).toContain('kstar_review_card');
    expect(conversation).toContain('_mountKstarResultReviewCard');
    for (const symbol of legacyRendererSymbols) {
      expect(conversation, `${symbol} must be removed`).not.toContain(symbol);
    }
  });

  it('removes legacy Conversation Info KSTAR compatibility surfaces', () => {
    const source = read('src/renderer/modules/conversation-info.js');
    expect(source).not.toContain('/kstar');
    expect(source).not.toContain('kstarRuns');
    expect(source).not.toContain('migrationStatus');
    expect(source).not.toContain('archives');
    expect(source).not.toContain('_renderKStarHistorySection');
  });

  it('removes retired migration/archive styles and keeps generic P3394 watermarks out of local/kstar', () => {
    const styles = read('src/renderer/style.css');
    expect(styles).not.toContain('conversation-info-kstar-migration');
    expect(styles).not.toContain('conversation-info-kstar-archive');

    const receiverStore = read('src/main/features/p3394/epoch-store.ts');
    const senderStore = read('src/main/features/p3394/sender-epoch-store.ts');
    const bus = read('src/main/features/group_chat/bus.ts');
    expect(receiverStore).toMatch(/function epochFile[\s\S]*?'local', 'p3394', 'p3394-epochs\.json'/);
    expect(senderStore).toMatch(/function senderEpochFile[\s\S]*?'local', 'p3394', 'p3394-sender-epochs\.json'/);
    expect(bus).not.toContain('<uid>/local/kstar/');
  });

  it('removes the legacy locale namespaces', () => {
    for (const locale of ['en', 'zh', 'ja', 'pt']) {
      const data = JSON.parse(read(`src/renderer/locales/${locale}.json`)) as Record<string, unknown>;
      expect(Object.keys(data).some((key) => key.startsWith('p3394.kstar.'))).toBe(false);
      expect(Object.keys(data).some((key) => key.startsWith('p3394.experience.'))).toBe(false);
      expect(data['kstar.review.card_title']).toBeTruthy();
    }
  });
});
