import * as workbench from '../features/desktop_workbench';

interface DesktopWorkbenchContext { userId: string }
type Handler = (payload: Record<string, unknown>, ctx: DesktopWorkbenchContext) => Promise<unknown> | unknown;

export const invokeHandlers: Record<string, Handler> = {
  'desktop_workbench.get': async (_payload, ctx) => ({ projection: await workbench.getDesktopWorkbenchProjection(ctx.userId) }),
};
