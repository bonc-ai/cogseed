import * as path from "node:path";

export interface CoordinatorAccessRequest {
  mode: "read" | "write";
  scopes: string[];
}

type PathFlavor = typeof path.posix | typeof path.win32;

interface NormalizedScope {
  flavor: PathFlavor;
  value: string;
}

interface ActiveEntry {
  request: CoordinatorAccessRequest;
}

interface Waiter {
  request: CoordinatorAccessRequest;
  signal?: AbortSignal;
  onAbort?: () => void;
  settled: boolean;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
}

function pathFlavor(value: string): PathFlavor {
  const driveRooted = /^[A-Za-z]:[\\/]/.test(value);
  const backslashUnc = /^\\\\/.test(value);
  return driveRooted || backslashUnc ? path.win32 : path.posix;
}

function normalizeScope(value: string): NormalizedScope {
  const raw = String(value || "");
  const flavor = pathFlavor(raw);
  const absolute = flavor.isAbsolute(raw) ? raw : flavor.resolve(raw);
  const normalized = flavor.normalize(absolute);
  return {
    flavor,
    value: flavor === path.win32 ? normalized.toLowerCase() : normalized,
  };
}

function scopeKey(scope: NormalizedScope): string {
  return `${scope.flavor === path.win32 ? "win32" : "posix"}:${scope.value}`;
}

function normalizedRequest(
  request: CoordinatorAccessRequest,
): CoordinatorAccessRequest {
  const scopes = new Map<string, string>();
  for (const rawScope of request.scopes) {
    const scope = normalizeScope(rawScope);
    scopes.set(scopeKey(scope), scope.value);
  }
  return {
    mode: request.mode === "read" ? "read" : "write",
    scopes: [...scopes.values()].sort(),
  };
}

function containsPath(parent: string, child: string): boolean {
  const normalizedParent = normalizeScope(parent);
  const normalizedChild = normalizeScope(child);
  if (normalizedParent.flavor !== normalizedChild.flavor) return false;
  const relative = normalizedParent.flavor.relative(
    normalizedParent.value,
    normalizedChild.value,
  );
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${normalizedParent.flavor.sep}`) &&
      !normalizedParent.flavor.isAbsolute(relative))
  );
}

export function accessRequestsConflict(
  leftRaw: CoordinatorAccessRequest,
  rightRaw: CoordinatorAccessRequest,
): boolean {
  const left = normalizedRequest(leftRaw);
  const right = normalizedRequest(rightRaw);
  if (left.mode === "read" && right.mode === "read") return false;
  return left.scopes.some((leftScope) =>
    right.scopes.some(
      (rightScope) =>
        containsPath(leftScope, rightScope) ||
        containsPath(rightScope, leftScope),
    ),
  );
}

export class CoordinatorAccessAdmission {
  private active: ActiveEntry[] = [];
  private waiters: Waiter[] = [];

  async acquire(
    requestRaw: CoordinatorAccessRequest,
    signal?: AbortSignal,
  ): Promise<() => void> {
    if (signal?.aborted) throw this.abortError();
    const request = normalizedRequest(requestRaw);
    const immediate = this.tryActivate(request);
    if (immediate) return immediate;

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        request,
        signal,
        settled: false,
        resolve,
        reject,
      };
      waiter.onAbort = () => {
        if (waiter.settled) return;
        waiter.settled = true;
        this.removeWaiter(waiter);
        this.removeAbortListener(waiter);
        reject(this.abortError());
        this.drain();
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  tryAcquire(requestRaw: CoordinatorAccessRequest): (() => void) | null {
    return this.tryActivate(normalizedRequest(requestRaw));
  }

  private tryActivate(request: CoordinatorAccessRequest): (() => void) | null {
    return this.mustQueue(request) ? null : this.activate(request);
  }

  abortWaiters(): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.settled) continue;
      waiter.settled = true;
      this.removeWaiter(waiter);
      this.removeAbortListener(waiter);
      waiter.reject(this.abortError());
    }
  }

  private mustQueue(request: CoordinatorAccessRequest): boolean {
    return (
      this.conflictsWithActive(request) ||
      this.waiters.some(
        (waiter) =>
          !waiter.settled && accessRequestsConflict(waiter.request, request),
      )
    );
  }

  private conflictsWithActive(request: CoordinatorAccessRequest): boolean {
    return this.active.some((entry) =>
      accessRequestsConflict(entry.request, request),
    );
  }

  private activate(request: CoordinatorAccessRequest): () => void {
    const entry: ActiveEntry = { request };
    let released = false;
    this.active.push(entry);
    return () => {
      if (released) return;
      released = true;
      const index = this.active.indexOf(entry);
      if (index >= 0) this.active.splice(index, 1);
      this.drain();
    };
  }

  private drain(): void {
    const blockedEarlier: Waiter[] = [];
    for (const waiter of [...this.waiters]) {
      if (waiter.settled) continue;
      if (waiter.signal?.aborted) {
        waiter.onAbort?.();
        continue;
      }
      const blockedByEarlier = blockedEarlier.some((earlier) =>
        accessRequestsConflict(earlier.request, waiter.request),
      );
      if (this.conflictsWithActive(waiter.request) || blockedByEarlier) {
        blockedEarlier.push(waiter);
        continue;
      }
      waiter.settled = true;
      this.removeWaiter(waiter);
      this.removeAbortListener(waiter);
      waiter.resolve(this.activate(waiter.request));
    }
  }

  private removeWaiter(waiter: Waiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
  }

  private removeAbortListener(waiter: Waiter): void {
    if (waiter.signal && waiter.onAbort)
      waiter.signal.removeEventListener("abort", waiter.onAbort);
  }

  private abortError(): Error {
    return Object.assign(new Error("Aborted"), { name: "AbortError" });
  }
}
