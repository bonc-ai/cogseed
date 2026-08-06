export function isRuntimeAborted(signal?: AbortSignal | null): boolean {
  return signal?.aborted === true;
}
