/**
 * Windows strong write-sandbox support.
 *
 * A genuinely OS-enforced write sandbox on Windows must spawn the child with
 * a restricted / low-integrity token through CreateProcessAsUser (or
 * CreateProcessWithTokenW). Those APIs require SeAssignPrimaryTokenPrivilege
 * and SeIncreaseQuotaPrivilege, which a UAC-filtered unelevated desktop app
 * does not hold. This module detects that capability and gives callers two
 * explicit behaviors:
 *
 *   - "strong"  (COGSEED_WINDOWS_SANDBOX_MODE=strong): fail closed when the
 *     OS-enforced sandbox cannot actually be created.
 *   - "auto"/"fallback" (default): keep the legacy behavior (no OS write
 *     enforcement on Windows) and emit a one-time warning.
 *
 * When the current process is an elevated CogSeed or a privileged broker,
 * windowsStrongSandboxAvailable() returns true and SandboxExecutor routes
 * the command through scripts/windows-sandbox-launch.ps1.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../shared/logger.js";

const log = createLogger("sandbox:windows");

export type WindowsSandboxMode = "auto" | "strong" | "fallback";

export function windowsSandboxMode(env: NodeJS.ProcessEnv = process.env): WindowsSandboxMode {
  const raw = String(env.COGSEED_WINDOWS_SANDBOX_MODE || "auto").trim().toLowerCase();
  if (raw === "strong") return "strong";
  if (raw === "fallback") return "fallback";
  return "auto";
}

function system32Tool(env: NodeJS.ProcessEnv, name: string): string {
  const root = env.SystemRoot || env.WINDIR || "C:\\Windows";
  return path.win32.join(root, "System32", name);
}

let availabilityCache: boolean | null = null;

/**
 * Whether the current Windows process can actually launch restricted-token
 * children. Returns false on non-Windows hosts and on UAC-filtered,
 * unelevated tokens (the normal desktop case).
 */
export function windowsStrongSandboxAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform !== "win32") return false;
  const forced = env.COGSEED_WINDOWS_SANDBOX_AVAILABLE_FORCE;
  if (forced === "1") return true;
  if (forced === "0") return false;
  if (availabilityCache !== null) return availabilityCache;
  availabilityCache = probeRestrictedTokenLaunchPrivileges(env);
  return availabilityCache;
}

/** Probe `whoami /priv` for the two privileges needed to spawn with a
 *  restricted token. Kept in one place for tests and the doctor report. */
export function probeRestrictedTokenLaunchPrivileges(env: NodeJS.ProcessEnv = process.env): boolean {
  const whoami = system32Tool(env, "whoami.exe");
  try {
    const result = spawnSync(whoami, ["/priv"], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
    if (result.status !== 0) return false;
    const text = result.stdout || "";
    const names = ["SeAssignPrimaryTokenPrivilege", "SeIncreaseQuotaPrivilege"];
    return names.every((name) =>
      new RegExp(`^${name}\\b[^\\r\\n]*\\bEnabled\\s*$`, "mi").test(text),
    );
  } catch {
    return false;
  }
}

/** Absolute path of the sandbox launcher, or null when the repo/packaging
 *  layout does not contain it. */
export function windowsSandboxLauncherPath(): string | null {
  const candidates: string[] = [];
  if (process.env.COGSEED_PC_DIR) {
    candidates.push(path.join(process.env.COGSEED_PC_DIR, "scripts", "windows-sandbox-launch.ps1"));
  }
  candidates.push(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..", "..", "..", "..",
      "scripts", "windows-sandbox-launch.ps1",
    ),
  );
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export interface WindowsSandboxLaunch {
  command: string;
  args: string[];
  envPatch: Record<string, string>;
}

/** Build the PowerShell invocation that runs `command` under a restricted,
 *  low-integrity token. The command and allowed dirs travel through env so no
 *  quoting layer can corrupt them. */
export function wrapWindowsStrongSandbox(
  command: string,
  allowedDirs: readonly string[],
  shellKind: "cmd" | "powershell" | "posix",
): WindowsSandboxLaunch {
  const launcher = windowsSandboxLauncherPath();
  if (!launcher) {
    throw new Error("Windows strong sandbox launcher script is missing (scripts/windows-sandbox-launch.ps1)");
  }
  return {
    command: system32Tool(process.env, "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", launcher],
    envPatch: {
      COGSEED_SANDBOX_COMMAND_B64: Buffer.from(command, "utf8").toString("base64"),
      COGSEED_SANDBOX_ALLOWED_DIRS_JSON: JSON.stringify(allowedDirs),
      COGSEED_SANDBOX_SHELL_KIND: shellKind,
    },
  };
}

export function resetWindowsSandboxAvailabilityCache(): void {
  availabilityCache = null;
}

export function warnWindowsSandboxUnavailable(mode: WindowsSandboxMode): string {
  const message = mode === "strong"
    ? "Windows strong sandbox unavailable: current process lacks the privileges to spawn restricted-token children. Run CogSeed elevated or provide a privileged broker (see scripts/windows-sandbox-launch.ps1)."
    : "Windows write sandbox unavailable (not elevated): falling back to unsandboxed execution. Set COGSEED_WINDOWS_SANDBOX_MODE=strong to fail closed, or run CogSeed elevated.";
  log.warn(message);
  return message;
}
