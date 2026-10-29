/** Reception setup over the canonical invoke bridge; no catalog mutations. */
import { getReceptionSetupReadOnly } from '../features/a2a/reception-service';

export const invokeHandlers = {
  'a2a.reception.setup': async (_payload: unknown, ctx: { userId: string }) =>
    getReceptionSetupReadOnly(ctx.userId),
};
