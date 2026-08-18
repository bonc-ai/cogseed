/**
 * Audit Receipt — proof of a governance action on an asset.
 *
 * PRD 原则 14：资产状态变化必须"先持久化事件并生成 Receipt，再更新界面"。
 * 事件（asset-events）是提交点；Receipt 记录 before/after 引用，供审计与回滚。
 *
 * 存储：`<uid>/cloud/cogseed/audit-receipts/<receipt_id>.json`（单文件）。
 * Receipt 写入失败不阻塞事件已提交——事件是事实源，Receipt 是可重建的证明。
 */

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createLogger } from '../../logger';
import { readJson, writeJson, nowIso } from '../../storage';
import { cogseedAgentAuditReceiptsDir } from '../../paths';
import { maskId } from '../../util/log-redact';

const log = createLogger('audit-receipt');

export interface AuditReceipt {
  receipt_id: string;
  event_ref: string;
  subject_ref: string;
  action: string;
  before_ref?: string;
  after_ref?: string;
  actor: 'user' | 'system';
  result: 'ok' | 'failed';
  timestamp: string;
}

export interface CreateAuditReceiptInput {
  eventId: string;
  subjectRef: string;
  action: string;
  beforeRef?: string;
  afterRef?: string;
  actor?: 'user' | 'system';
  result?: 'ok' | 'failed';
}

export function auditReceiptPath(uid: string, receiptId: string): string {
  return path.join(cogseedAgentAuditReceiptsDir(uid), `${receiptId}.json`);
}

export async function createAuditReceipt(uid: string, input: CreateAuditReceiptInput): Promise<AuditReceipt> {
  const receipt: AuditReceipt = {
    receipt_id: `rcpt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    event_ref: input.eventId,
    subject_ref: input.subjectRef,
    action: input.action,
    ...(input.beforeRef ? { before_ref: input.beforeRef } : {}),
    ...(input.afterRef ? { after_ref: input.afterRef } : {}),
    actor: input.actor ?? 'system',
    result: input.result ?? 'ok',
    timestamp: nowIso(),
  };
  await writeJson(auditReceiptPath(uid, receipt.receipt_id), receipt);
  return receipt;
}

export async function readAuditReceipt(uid: string, receiptId: string): Promise<AuditReceipt | null> {
  try {
    return await readJson<AuditReceipt>(auditReceiptPath(uid, receiptId));
  } catch (err) {
    log.warn(`read audit receipt user=${maskId(uid)} rcpt=${maskId(receiptId)}: ${(err as Error).message}`);
    return null;
  }
}
