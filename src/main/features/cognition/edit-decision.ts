/** Host-authored, immutable receipt of the exact contract a person edited. */
import { z } from 'zod';

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);
export const cognitionEditDecisionSchema = z.object({
  id, ownerId: id, cid: id, sourceMessageId: id,
  method: z.enum(['exact_patch', 'full_preview']), interactionId: id.optional(),
  targetId: id, previousVersion: z.string().regex(/^\d+$/),
  previousActiveVersion: z.string().regex(/^\d+$/), committedVersion: z.string().regex(/^\d+$/),
  changedFields: z.array(z.string().min(1).max(100)).min(1).max(50),
  patch: z.record(z.unknown()), createdAt: z.string().datetime({ offset: true }),
}).strict().refine(value => value.method !== 'full_preview' || Boolean(value.interactionId), { message: 'complete preview requires its resolved interaction' });
export type CognitionEditDecision = z.infer<typeof cognitionEditDecisionSchema>;
