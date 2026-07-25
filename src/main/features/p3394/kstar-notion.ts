import * as fs from 'node:fs';
import * as path from 'node:path';

import { userContextsDir } from '../../paths';
import * as connectors from '../connectors/manager';
import {
  getExperienceCandidate,
  getKStarRun,
  markExperienceCandidateNotionSync,
  type ExperienceCandidate,
  type KStarRun,
} from './kstar-runtime';

interface NotionSyncConfig {
  connectorId: string;
  parentId: string;
  parentType: 'page' | 'database';
  titleProperty: string;
  createPageTool: string;
}

function readConfig(): NotionSyncConfig | null {
  const parentId = String(process.env.ORKAS_KSTAR_NOTION_PARENT_ID || '').trim();
  if (!parentId) return null;
  const parentTypeRaw = String(process.env.ORKAS_KSTAR_NOTION_PARENT_TYPE || 'page').trim().toLowerCase();
  return {
    connectorId: String(process.env.ORKAS_KSTAR_NOTION_CONNECTOR_ID || 'notion').trim() || 'notion',
    parentId,
    parentType: parentTypeRaw === 'database' ? 'database' : 'page',
    titleProperty: String(process.env.ORKAS_KSTAR_NOTION_TITLE_PROPERTY || 'Name').trim() || 'Name',
    createPageTool: String(process.env.ORKAS_KSTAR_NOTION_CREATE_PAGE_TOOL || 'API-post-page').trim() || 'API-post-page',
  };
}

function titleFor(candidate: ExperienceCandidate, run: KStarRun): string {
  const task = run.kstar_episode?.task || run.kstar_decision?.expectation?.task || candidate.summary || candidate.id;
  const clipped = task.length > 80 ? `${task.slice(0, 80)}…` : task;
  return `KSTAR Experience: ${clipped}`;
}

function richText(content: string) {
  return [{ type: 'text', text: { content: content.slice(0, 1900) } }];
}

function markdownToBlocks(markdown: string): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let paragraph: string[] = [];
  const flushParagraph = () => {
    const text = paragraph.join('\n').trim();
    paragraph = [];
    if (!text) return;
    blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: richText(text) } });
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { flushParagraph(); continue; }
    const h2 = /^##\s+(.+)/.exec(trimmed);
    if (h2) {
      flushParagraph();
      blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: richText(h2[1]) } });
      continue;
    }
    const h1 = /^#\s+(.+)/.exec(trimmed);
    if (h1) {
      flushParagraph();
      blocks.push({ object: 'block', type: 'heading_1', heading_1: { rich_text: richText(h1[1]) } });
      continue;
    }
    const bullet = /^[-*]\s+(.+)/.exec(trimmed);
    if (bullet) {
      flushParagraph();
      blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: richText(bullet[1]) } });
      continue;
    }
    paragraph.push(line);
    if (blocks.length >= 80) break;
  }
  flushParagraph();
  return blocks.slice(0, 90);
}

function parseMcpJson(result: unknown): Record<string, unknown> {
  const content = (result as { content?: unknown } | null)?.content;
  if (Array.isArray(content)) {
    const text = content.map((item) => {
      if (item && typeof item === 'object' && (item as { type?: unknown }).type === 'text') {
        return String((item as { text?: unknown }).text || '');
      }
      return '';
    }).join('\n').trim();
    if (text) {
      try { return JSON.parse(text) as Record<string, unknown>; }
      catch { return { text }; }
    }
  }
  return result && typeof result === 'object' ? result as Record<string, unknown> : { value: result };
}

function findStringDeep(obj: unknown, keys: string[]): string {
  if (!obj || typeof obj !== 'object') return '';
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  for (const value of Object.values(record)) {
    const found = findStringDeep(value, keys);
    if (found) return found;
  }
  return '';
}

function buildCreatePageArgs(config: NotionSyncConfig, candidate: ExperienceCandidate, run: KStarRun, markdown: string): Record<string, unknown> {
  const title = titleFor(candidate, run);
  const parent = config.parentType === 'database'
    ? { database_id: config.parentId }
    : { page_id: config.parentId };
  const properties = config.parentType === 'database'
    ? {
        [config.titleProperty]: { title: richText(title) },
        'KB Path': { rich_text: richText(candidate.kb_path || '') },
        'Agent': { rich_text: richText(run.agent_id) },
      }
    : { title: { title: richText(title) } };
  return {
    parent,
    properties,
    children: markdownToBlocks(markdown),
  };
}

export async function syncExperienceCandidateToNotion(
  uid: string,
  candidateId: string,
): Promise<{ ok: true; candidate: ExperienceCandidate; page_id?: string; url?: string } | { ok: false; error: string; candidate?: ExperienceCandidate }> {
  const candidate = await getExperienceCandidate(uid, candidateId);
  if (!candidate) return { ok: false, error: 'experience candidate not found' };
  if (candidate.status !== 'approved') return { ok: false, error: `experience candidate must be approved before Notion sync (current: ${candidate.status})`, candidate };
  if (!candidate.kb_path || candidate.promotion_status !== 'promoted') {
    return { ok: false, error: 'experience candidate must be promoted to Knowledge Base before Notion sync', candidate };
  }
  if (candidate.notion_sync?.status === 'synced') {
    return { ok: true, candidate, page_id: candidate.notion_sync.page_id, url: candidate.notion_sync.url };
  }
  const config = readConfig();
  if (!config) {
    const updated = await markExperienceCandidateNotionSync(uid, candidate.id, {
      status: 'failed',
      error: 'Notion sync target is not configured. Set ORKAS_KSTAR_NOTION_PARENT_ID.',
    });
    return { ok: false, error: updated.notion_sync?.error || 'Notion sync target is not configured.', candidate: updated };
  }
  const run = await getKStarRun(uid, candidate.source_run_id);
  if (!run) return { ok: false, error: 'source KSTAR run not found', candidate };
  const kbAbs = path.join(userContextsDir(uid), candidate.kb_path);
  let markdown = '';
  try { markdown = fs.readFileSync(kbAbs, 'utf8'); }
  catch { return { ok: false, error: 'Knowledge Base markdown file not found', candidate }; }

  try {
    const raw = await connectors.callTool(uid, config.connectorId, config.createPageTool, buildCreatePageArgs(config, candidate, run, markdown));
    const parsed = parseMcpJson(raw);
    const pageId = findStringDeep(parsed, ['id', 'page_id']);
    const url = findStringDeep(parsed, ['url', 'public_url']);
    const updated = await markExperienceCandidateNotionSync(uid, candidate.id, {
      status: 'synced',
      page_id: pageId,
      url,
      result: parsed,
    });
    return { ok: true, candidate: updated, page_id: pageId, url };
  } catch (err) {
    const message = (err as Error).message || String(err);
    const updated = await markExperienceCandidateNotionSync(uid, candidate.id, { status: 'failed', error: message });
    return { ok: false, error: message, candidate: updated };
  }
}
