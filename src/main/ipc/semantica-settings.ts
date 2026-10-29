import * as semantica from '../features/recall/semantica-settings';
export const invokeHandlers = {
  'semantica.settings.get': async (_payload: unknown, ctx: { userId: string }) => ({
    settings: semantica.settingsView(ctx.userId),
  }),
  'semantica.settings.save': async (payload: Record<string, unknown>, ctx: { userId: string }) => {
    const settings = semantica.updateSemanticaSettings({
      ...(typeof payload.semanticaEnabled === 'boolean' ? { semanticaEnabled: payload.semanticaEnabled } : {}),
    });
    return { settings: semantica.settingsView(ctx.userId), saved: settings };
  },
};
