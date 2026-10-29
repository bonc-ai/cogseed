/** Owner management reads are not editing or task-use authority. No model
 * argument or cursor can grant them: broad inspection comes from the actual
 * current user row, and each caller still checks current sources. */
import { createHash } from 'node:crypto';
import { t } from '../../i18n';
import { esticogseedToolResultTokens } from '../../util/tool-result-cap';
import { readHumanInstructionSource } from './human-instruction-provenance';
import { assertCognitionManagementTarget, type CognitionEditHost } from './edit-service';
import { OntologyError } from './ontology/model';

export type ManagementReadDomain = 'asset' | 'ontology';
export const MANAGEMENT_PAGE_TOKENS = 5_500;
export const MANAGEMENT_CHUNK_TOKENS = 1_500;
const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)])) : v;
export const managementReadText = (v: unknown): string => JSON.stringify(stable(v));
/** Functional stale-read binding, not an authorization token. */
export const managementReadVersion = (v: unknown): string => createHash('sha256').update(managementReadText(v)).digest('hex');

export function hasFullManagementReadIntent(text: string, domain: ManagementReadDomain): boolean {
  // Quoted examples and code cannot authorize a whole private pool. Preserve a
  // marker so a quoted single target cannot disappear into an "all" phrase.
  const s = text.replace(/```[\s\S]*?```/g, '').replace(/^(?:\s*>.*\n?)+/gm, '')
    .replace(/[“「『"][\s\S]*?[”」』"]/g, ' [quoted] ').trim();
  if (/(?:不要|不许|禁止|别|暂不|无需|do not|don't|never)\s*[^。；;\n]{0,24}(?:盘点|列出|读取|查看|整理|inventory|list|read|inspect)/i.test(s)) return false;
  // Polite questions can be direct requests ("Can you list all my ...?").
  // Capability/feature questions alone do not ask to perform the inventory.
  if (/(?:支持|功能|capabilit|support|feature)/i.test(s) && !/请|帮我|我希望|我想|\bplease\b|\bi (?:want|would like)\b/i.test(s)) return false;
  const object = domain === 'ontology' ? /本体|\bontolog(?:y|ies)\b/i : /资产|\b(?:ability[ -]assets?|cognitions?|assets?)\b/i;
  const noun = '(?:认知资产|资产|本体)', nouns = `${noun}(?:\\s*(?:和|与|及|、|以及)\\s*${noun})*`;
  const english = '(?:ability[ -]assets?|assets?|cognitions?|ontolog(?:y|ies))', englishNouns = `${english}(?:\\s+(?:and|&)\\s+${english})*`;
  const expressions = [new RegExp(`(?:全部|所有|全量|完整)(?:盘点|读取|列出|审阅|查看|整理|核对)?(?:的|我的|本人的|现有|当前|个人|\\s)*(${nouns})`, 'gi'),
    new RegExp(`(${nouns})\\s*的?\\s*(?:全部|所有|全量|完整)(?:内容|记录|正文|信息|清单)?`, 'gi'),
    new RegExp(`\\b(?:all|every|entire)\\s+(?:(?:of\\s+)?(?:my|the|our|current)\\s+)?(${englishNouns})\\b`, 'gi'),
    new RegExp(`\\b(?:complete|entire)\\s+(?:content|contents|inventory)\\s+of\\s+(?:my\\s+)?(${englishNouns})\\b`, 'gi')];
  // Bind the quantifier to this domain's noun phrase, not another clause's
  // "all". In particular all ontologies + asset aa-x is not all assets.
  return s.split(/[，,。；;\n]/).some(clause => /盘点|列出|读取|查看|整理|核对|审阅|展示|\b(?:inventory|list|read|inspect|review|audit|show)\b/i.test(clause)
    && expressions.some(re => { re.lastIndex = 0; return [...clause.matchAll(re)].some(match => {
      if (!object.test(match[1])) return false;
      const nounStart = match.index! + match[0].indexOf(match[1]);
      return [...match[1].matchAll(new RegExp(object.source, 'gi'))].some(target => {
        const rest = clause.slice(nounStart + target.index! + target[0].length).trimStart();
        // IDs, quoted names and narrower selectors do not authorize the rest
        // of that domain merely because a preceding sibling said "all".
        return !rest || /^(?:和|与|及|、|以及|的|全部|所有|全量|完整|内容|记录|正文|信息|清单|数据|列表|详情|[。；;!?！？])/i.test(rest)
          || /^(?:and\b|&|contents?\b|records?\b|data\b|details?\b|inventory\b|now\b|please\b|today\b)/i.test(rest);
      });
    }); }));
}
export async function assertFullManagementRead(userId: string, host: CognitionEditHost, domain: ManagementReadDomain): Promise<void> {
  if (host.userId !== userId || host.sourceMessageFromUser !== true || !host.cid || !host.sourceMessageId)
    throw new OntologyError('inventory_intent_required', t('cognition.read.inventory_intent_required'));
  const source = await readHumanInstructionSource(userId, host.cid, host.sourceMessageId);
  if (!hasFullManagementReadIntent(source.text, domain)) throw new OntologyError('inventory_intent_required', t('cognition.read.inventory_intent_required'));
}
export async function assertCognitionManagementReadTarget(userId: string, host: CognitionEditHost,
  domain: ManagementReadDomain, record: { id: string; title?: string; name?: string; ownerId?: string },
  doc?: import('./ontology/model').OntologyDocument): Promise<'named' | 'inventory'> {
  if (host.userId !== userId || (domain === 'asset' ? record.ownerId !== userId : doc?.ownerId !== userId || !doc.records[record.id]))
    throw new OntologyError('not_authorized', t('cognition.read.owner_mismatch'));
  try { assertCognitionManagementTarget(host, record, doc); return 'named'; }
  catch (error) {
    // A whole-pool read may address any actual owner ID, including duplicate
    // names. This deliberately does not alter the helper used by edit writes.
    await assertFullManagementRead(userId, host, domain);
    return 'inventory';
  }
}

type ReadCursor = { v: 1; key: string; version: string; offset: number };
export function encodeManagementCursor(key: string, version: string, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, key, version, offset })).toString('base64url');
}
export function decodeManagementCursor(raw: unknown, key: string, version: string): number {
  if (typeof raw !== 'string' || !raw || raw.length > 2_000) throw new OntologyError('invalid_cursor', t('cognition.read.invalid_cursor'));
  let c: ReadCursor; try { c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { throw new OntologyError('invalid_cursor', t('cognition.read.invalid_cursor')); }
  if (!c || c.v !== 1 || c.key !== key || !Number.isSafeInteger(c.offset) || c.offset < 0) throw new OntologyError('invalid_cursor', t('cognition.read.invalid_cursor'));
  if (c.version !== version) throw new OntologyError('inventory_snapshot_changed', t('cognition.read.snapshot_changed'));
  return c.offset;
}
/** Rebuild this complete contract from current domains BEFORE every call.
 * Chunking JSON rather than just its body preserves all conditions/metadata. */
export function managementContentChunk(userId: string, domain: ManagementReadDomain, id: string, contract: unknown, cursor: unknown) {
  const text = managementReadText(contract), version = managementReadVersion(contract), key = `${userId}:${domain}:${id}:content`;
  const offset = cursor === 0 || cursor === '0' ? 0 : decodeManagementCursor(cursor, key, version);
  if (offset > text.length || offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] || '')) throw new OntologyError('invalid_cursor', t('cognition.read.invalid_cursor'));
  let end = offset;
  for (const point of text.slice(offset)) {
    if (esticogseedToolResultTokens(text.slice(offset, end + point.length)) > MANAGEMENT_CHUNK_TOKENS) break;
    end += point.length;
  }
  const mode = contract && typeof contract === 'object' && 'mode' in contract && contract.mode === 'task' ? 'task' : 'manage';
  return { mode, format: 'complete-management-contract-json', id, version,
    contentRange: { start: offset, end, total: text.length }, content: text.slice(offset, end),
    nextContentCursor: end < text.length ? encodeManagementCursor(key, version, end) : null,
    contentComplete: offset === 0 && end === text.length,
    useBoundary: t('cognition.read.use_boundary') };
}
