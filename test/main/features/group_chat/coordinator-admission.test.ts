import { describe, expect, it, vi } from "vitest";
import {
  CoordinatorAccessAdmission,
  accessRequestsConflict,
} from "../../../../src/main/features/group_chat/coordinator_admission";

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("group_chat coordinator access conflicts", () => {
  it("allows overlapping read scopes", () => {
    expect(
      accessRequestsConflict(
        { mode: "read", scopes: ["/workspace/a"] },
        { mode: "read", scopes: ["/workspace/a/file.txt"] },
      ),
    ).toBe(false);
  });

  it.each([
    ["write", "read"],
    ["read", "write"],
    ["write", "write"],
  ] as const)(
    "conflicts for ancestor and descendant scopes when modes are %s/%s",
    (leftMode, rightMode) => {
      expect(
        accessRequestsConflict(
          { mode: leftMode, scopes: ["/workspace/a/../a"] },
          { mode: rightMode, scopes: ["/workspace/a/nested/file.txt"] },
        ),
      ).toBe(true);
    },
  );

  it("allows disjoint writes and rejects sibling-prefix false positives", () => {
    expect(
      accessRequestsConflict(
        { mode: "write", scopes: ["/workspace/a"] },
        { mode: "write", scopes: ["/workspace/ab"] },
      ),
    ).toBe(false);
    expect(
      accessRequestsConflict(
        { mode: "write", scopes: ["/workspace/a"] },
        { mode: "write", scopes: ["/workspace/b"] },
      ),
    ).toBe(false);
  });

  it("normalizes Windows paths by components on every host platform", () => {
    expect(
      accessRequestsConflict(
        { mode: "write", scopes: ["C:\\Work\\src\\..\\src"] },
        { mode: "read", scopes: ["c:\\work\\src\\index.ts"] },
      ),
    ).toBe(true);
    expect(
      accessRequestsConflict(
        { mode: "write", scopes: ["C:\\Work\\src"] },
        { mode: "write", scopes: ["C:\\Work\\src-old"] },
      ),
    ).toBe(false);
  });

  it("keeps POSIX case and backslashes component-sensitive", () => {
    expect(
      accessRequestsConflict(
        { mode: "write", scopes: ["/workspace/Foo"] },
        { mode: "read", scopes: ["/workspace/foo/file.txt"] },
      ),
    ).toBe(false);
    expect(
      accessRequestsConflict(
        { mode: "write", scopes: ["/workspace/a\\b"] },
        { mode: "write", scopes: ["/workspace/a/b"] },
      ),
    ).toBe(false);
  });

  it("treats drive-rooted and backslash UNC paths as case-insensitive Windows paths", () => {
    expect(
      accessRequestsConflict(
        { mode: "write", scopes: ["D:/Workspace/Folder"] },
        { mode: "read", scopes: ["d:\\workspace\\folder\\file.txt"] },
      ),
    ).toBe(true);
    expect(
      accessRequestsConflict(
        { mode: "write", scopes: ["\\\\Server\\Share\\Folder"] },
        { mode: "read", scopes: ["\\\\server\\share\\folder\\child"] },
      ),
    ).toBe(true);
    expect(
      accessRequestsConflict(
        { mode: "write", scopes: ["D:\\Workspace\\Folder"] },
        { mode: "write", scopes: ["d:\\workspace\\folder-old"] },
      ),
    ).toBe(false);
  });
});

describe("CoordinatorAccessAdmission", () => {
  it("deduplicates normalized scopes and admits a conflict after release", async () => {
    const admission = new CoordinatorAccessAdmission();
    const releaseFirst = await admission.acquire({
      mode: "write",
      scopes: ["/workspace/a", "/workspace/a/../a", "/workspace/a"],
    });
    let admitted = false;
    const waiting = admission
      .acquire({ mode: "read", scopes: ["/workspace/a/file.txt"] })
      .then((release) => {
        admitted = true;
        return release;
      });

    await tick();
    expect(admitted).toBe(false);
    expect((admission as any).active).toHaveLength(1);
    expect((admission as any).waiters).toHaveLength(1);

    releaseFirst();
    const releaseWaiting = await waiting;
    expect(admitted).toBe(true);
    expect((admission as any).active).toHaveLength(1);
    expect((admission as any).waiters).toHaveLength(0);
    releaseWaiting();
  });

  it("admits disjoint waiters deterministically without bypassing an earlier conflicting writer", async () => {
    const admission = new CoordinatorAccessAdmission();
    const order: string[] = [];
    const releaseRead = await admission.acquire({
      mode: "read",
      scopes: ["/workspace/a"],
    });
    const writer = admission
      .acquire({ mode: "write", scopes: ["/workspace/a"] })
      .then((release) => {
        order.push("writer");
        return release;
      });
    const laterRead = admission
      .acquire({ mode: "read", scopes: ["/workspace/a/child"] })
      .then((release) => {
        order.push("later-read");
        return release;
      });
    const disjointWrite = admission
      .acquire({ mode: "write", scopes: ["/workspace/b"] })
      .then((release) => {
        order.push("disjoint-write");
        return release;
      });

    const releaseDisjoint = await disjointWrite;
    expect(order).toEqual(["disjoint-write"]);
    releaseDisjoint();
    releaseRead();
    const releaseWriter = await writer;
    expect(order).toEqual(["disjoint-write", "writer"]);
    await tick();
    expect(order).toEqual(["disjoint-write", "writer"]);
    releaseWriter();
    const releaseLaterRead = await laterRead;
    expect(order).toEqual(["disjoint-write", "writer", "later-read"]);
    releaseLaterRead();
  });

  it("makes release idempotent", async () => {
    const admission = new CoordinatorAccessAdmission();
    const release = await admission.acquire({
      mode: "write",
      scopes: ["/workspace"],
    });
    release();
    release();
    expect((admission as any).active).toHaveLength(0);
    expect((admission as any).waiters).toHaveLength(0);
  });

  it("rejects an aborted waiter with AbortError and removes its listener", async () => {
    const admission = new CoordinatorAccessAdmission();
    const release = await admission.acquire({
      mode: "write",
      scopes: ["/workspace"],
    });
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    const waiting = admission.acquire(
      { mode: "read", scopes: ["/workspace/file"] },
      controller.signal,
    );

    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    expect((admission as any).active).toHaveLength(1);
    expect((admission as any).waiters).toHaveLength(0);
    release();
  });

  it.each(["abort-first", "release-first"])(
    "settles an abort/release race once with no leaked entry: %s",
    async (raceOrder) => {
      const admission = new CoordinatorAccessAdmission();
      const release = await admission.acquire({
        mode: "write",
        scopes: ["/workspace"],
      });
      const controller = new AbortController();
      let fulfilled = 0;
      let rejected = 0;
      const waiting = admission
        .acquire(
          { mode: "write", scopes: ["/workspace"] },
          controller.signal,
        )
        .then(
          (nextRelease) => {
            fulfilled += 1;
            nextRelease();
          },
          (error) => {
            rejected += 1;
            expect(error).toMatchObject({ name: "AbortError" });
          },
        );

      if (raceOrder === "abort-first") {
        controller.abort();
        release();
      } else {
        release();
        controller.abort();
      }
      await waiting;
      expect(fulfilled + rejected).toBe(1);
      expect((admission as any).active).toHaveLength(0);
      expect((admission as any).waiters).toHaveLength(0);
    },
  );
});
