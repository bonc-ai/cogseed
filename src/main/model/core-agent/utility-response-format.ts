/** Explicit JSON formatting for tool-free, transient utility calls. JSON mode
 * constrains syntax only; callers must still validate schema and evidence. */
export type UtilityResponseFormat = 'json_object';
export interface UtilityResponseFormatOptions {
  responseFormat?: UtilityResponseFormat;
  disableTools?: boolean;
  ephemeralSession?: boolean;
}
export function assertUtilityResponseFormat(options: UtilityResponseFormatOptions): void {
  if (options.responseFormat === undefined) return;
  if (options.responseFormat !== 'json_object' || options.disableTools !== true || options.ephemeralSession !== true) {
    throw new Error('JSON response format requires a tool-free ephemeral utility session');
  }
}
type PayloadHook = (payload: unknown, model: { api?: string }) => unknown | Promise<unknown>;
export function composeUtilityResponseFormatOnPayload(
  providerId: string, responseFormat: UtilityResponseFormat | undefined, existingHook?: PayloadHook,
): PayloadHook {
  return async (payload, model) => {
    const transformed = existingHook ? await existingHook(payload, model) : undefined;
    const current = transformed === undefined ? payload : transformed;
    // The route identity is the actual rotating candidate, and API identity
    // comes from the SDK's resolved model (including configured fallbacks).
    if (responseFormat !== 'json_object' || providerId !== 'zai' || model?.api !== 'openai-completions'
      || !current || typeof current !== 'object' || Array.isArray(current)) return current;
    return { ...current, response_format: { type: 'json_object' } };
  };
}
