/**
 * Windows write-sandbox policy.
 *
 * The previous experimental launcher lowered integrity labels on caller-owned
 * directories before spawning a restricted token. Directory labels are
 * machine-wide persistent ACL state: an app crash or overlapping runs can
 * leave them changed, so that design cannot be used as a security boundary.
 * Until a privileged broker can grant per-process access without mutating
 * user directories, Windows exposes two explicit behaviors:
 *
 *   - "strong"  (COGSEED_WINDOWS_SANDBOX_MODE=strong): fail closed when the
 *     OS-enforced sandbox cannot actually be created.
 *   - "auto"/"fallback" (default): keep the legacy behavior (no OS write
 *     enforcement on Windows) and emit a one-time warning.
 *
 * `windowsStrongSandboxAvailable()` intentionally remains false, including
 * for elevated processes and test overrides. This prevents an unsafe launcher
 * from being re-enabled accidentally.
 */
import { createLogger } from "../shared/logger.js";

const log = createLogger("sandbox:windows");

export type WindowsSandboxMode = "auto" | "strong" | "fallback";

export function windowsSandboxMode(env: NodeJS.ProcessEnv = process.env): WindowsSandboxMode {
  const raw = String(env.COGSEED_WINDOWS_SANDBOX_MODE || "auto").trim().toLowerCase();
  if (raw === "strong") return "strong";
  if (raw === "fallback") return "fallback";
  return "auto";
}

/**
 * Strong Windows sandboxing is disabled until it can be implemented without
 * persistent mutation of caller-owned directory ACLs.
 */
export function windowsStrongSandboxAvailable(_env: NodeJS.ProcessEnv = process.env): boolean {
  return false;
}

export function warnWindowsSandboxUnavailable(mode: WindowsSandboxMode): string {
  const message = mode === "strong"
    ? "Windows strong sandbox unavailable: safe per-process write isolation requires a privileged broker; strong mode fails closed."
    : "Windows write sandbox unavailable: falling back to policy-checked execution. Set COGSEED_WINDOWS_SANDBOX_MODE=strong to fail closed.";
  log.warn(message);
  return message;
}
