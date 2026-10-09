import { describe, expect, it } from "vitest";
import type { Agent } from "../../../../src/main/features/agents";
import type { WorkflowAttempt } from "../../../../src/main/features/group_chat/collaboration";
import type { Actor } from "../../../../src/main/features/group_chat/state";
import {
  nextRecoveryAction,
  selectFallbackAgent,
} from "../../../../src/main/features/group_chat/coordinator_recovery";

function attempt(
  attemptNumber: number,
  actorId: string | null,
  actorKind: WorkflowAttempt["actor_kind"] = "agent",
  failureCode: WorkflowAttempt["failure_code"] = "coordinator_agent_idle",
): WorkflowAttempt {
  return {
    attempt: attemptNumber,
    actor_id: actorId,
    actor_kind: actorKind,
    status: "failed",
    failure_code: failureCode,
    started_at: `2026-07-31T00:00:0${attemptNumber}.000Z`,
    completed_at: `2026-07-31T00:00:1${attemptNumber}.000Z`,
  };
}

function member(id: string, kind: Actor["kind"] = "agent"): Actor {
  return {
    id,
    kind,
    name: id,
    joined_at: "2026-07-31T00:00:00.000Z",
  };
}

function agent(
  agentId: string,
  overrides: Partial<Agent> = {},
): Agent {
  return {
    agent_id: agentId,
    name: agentId,
    description_zh: "",
    description_en: "",
    workflow: "",
    category: "",
    source: "custom",
    created_at: "2026-07-31T00:00:00.000Z",
    updated_at: "2026-07-31T00:00:00.000Z",
    enabled: true,
    ...overrides,
  } as Agent;
}

describe("coordinator recovery policy", () => {
  it("walks the complete finite recovery chain", () => {
    const firstFailure = [attempt(1, "original")];
    const originalFailedTwice = [
      ...firstFailure,
      attempt(2, "original"),
    ];
    const namedFallbackFailed = [
      ...originalFailedTwice,
      attempt(3, "fallback", "agent", "runtime_failed"),
    ];
    const anonymousFailed = [
      ...namedFallbackFailed,
      attempt(4, null, "anonymous_worker", "runtime_failed"),
    ];

    expect(nextRecoveryAction({
      attempts: firstFailure,
      abortSource: "coordinator",
    })).toEqual({ kind: "retry_same" });
    expect(nextRecoveryAction({
      attempts: originalFailedTwice,
      abortSource: "coordinator",
    })).toEqual({ kind: "select_fallback" });
    expect(nextRecoveryAction({
      attempts: namedFallbackFailed,
      abortSource: "coordinator",
    })).toEqual({ kind: "run_anonymous" });
    expect(nextRecoveryAction({
      attempts: anonymousFailed,
      abortSource: "coordinator",
    })).toEqual({ kind: "return_commander" });
  });

  it.each(["user", "group_abort", "parent_abort"] as const)(
    "stops immediately for %s aborts",
    (abortSource) => {
      expect(nextRecoveryAction({
        attempts: [attempt(1, "original")],
        abortSource,
      })).toEqual({ kind: "stop" });
    },
  );

  it("returns to Commander with no attempts or after the four-attempt bound", () => {
    expect(nextRecoveryAction({
      attempts: [],
      abortSource: "coordinator",
    })).toEqual({ kind: "return_commander" });

    expect(nextRecoveryAction({
      attempts: [
        attempt(1, "original"),
        attempt(2, "original"),
        attempt(3, "fallback", "agent", "runtime_failed"),
        attempt(4, null, "anonymous_worker", "runtime_failed"),
        attempt(5, null, "anonymous_worker", "runtime_failed"),
      ],
      abortSource: "coordinator",
    })).toEqual({ kind: "return_commander" });
  });

  it("selects a fallback for dependency failures and never retries the same actor", () => {
    expect(nextRecoveryAction({
      attempts: [attempt(1, "original", "agent", "dependency_failed")],
      abortSource: "coordinator",
    })).toEqual({ kind: "select_fallback" });
  });

  it.each(["running", "completed", "cancelled"] as const)(
    "fails safe when an earlier attempt is %s",
    (status) => {
      expect(nextRecoveryAction({
        attempts: [
          { ...attempt(1, "original"), status },
          attempt(2, "original"),
        ],
        abortSource: "coordinator",
      })).toEqual({ kind: "return_commander" });
    },
  );

  it.each([
    { started_at: "" },
    { started_at: "not-a-date" },
    { started_at: "123" },
    { completed_at: undefined },
    { completed_at: "not-a-date" },
  ])("requires individually valid terminal timestamps %#", (overrides) => {
    expect(nextRecoveryAction({
      attempts: [{
        ...attempt(1, "original"),
        ...overrides,
      } as WorkflowAttempt],
      abortSource: "coordinator",
    })).toEqual({ kind: "return_commander" });
  });

  it("accepts persisted timezone-less nowIso-style timestamps", () => {
    expect(nextRecoveryAction({
      attempts: [{
        ...attempt(1, "original"),
        started_at: "2026-08-01T15:10:00",
        completed_at: "2026-08-01T15:10:01.125",
      }],
      abortSource: "coordinator",
    })).toEqual({ kind: "retry_same" });
  });

  it("does not reject a rollback-shaped local wall-clock interval", () => {
    expect(nextRecoveryAction({
      attempts: [{
        ...attempt(1, "original"),
        started_at: "2026-11-01T01:59:59",
        completed_at: "2026-11-01T01:00:00",
      }],
      abortSource: "coordinator",
    })).toEqual({ kind: "retry_same" });
  });

  it.each([
    "2026-00-10T12:00:00",
    "2026-13-10T12:00:00",
    "2026-04-31T12:00:00",
    "2026-02-29T12:00:00",
    "2024-02-30T12:00:00",
    "2026-01-00T12:00:00",
    "2026-01-01T24:00:00",
    "2026-01-01T23:60:00",
    "2026-01-01T23:59:60",
    "2026-01-01T23:59:59.1234",
    "2026-01-01T23:59:59+14:01",
    "2026-01-01T23:59:59+15:00",
    "2026-01-01T23:59:59-14:01",
    "2026-01-01T23:59:59+01:60",
  ])("rejects invalid calendar, clock, fraction, and offset values: %s", (startedAt) => {
    expect(nextRecoveryAction({
      attempts: [{
        ...attempt(1, "original"),
        started_at: startedAt,
      }],
      abortSource: "coordinator",
    })).toEqual({ kind: "return_commander" });
  });

  it("accepts valid leap-day and maximum-offset timestamps", () => {
    expect(nextRecoveryAction({
      attempts: [{
        ...attempt(1, "original"),
        started_at: "2024-02-29T23:59:59.1+14:00",
        completed_at: "2024-02-29T23:59:59.999+14:00",
      }],
      abortSource: "coordinator",
    })).toEqual({ kind: "retry_same" });
  });

  it.each([
    {
      started_at: "2026-08-01T10:00:00Z",
      completed_at: "2026-08-01T09:59:59Z",
    },
    {
      started_at: "2026-08-01T10:00:00+02:00",
      completed_at: "2026-08-01T10:30:00+03:00",
    },
  ])("rejects reversed unambiguous absolute intervals %#", (timestamps) => {
    expect(nextRecoveryAction({
      attempts: [{
        ...attempt(1, "original"),
        ...timestamps,
      }],
      abortSource: "coordinator",
    })).toEqual({ kind: "return_commander" });
  });

  it("does not order a mixed explicit/local wall-clock interval", () => {
    expect(nextRecoveryAction({
      attempts: [{
        ...attempt(1, "original"),
        started_at: "2026-08-01T10:00:00Z",
        completed_at: "2026-08-01T09:00:00",
      }],
      abortSource: "coordinator",
    })).toEqual({ kind: "retry_same" });
  });

  it.each([
    { failure_code: undefined },
    { failure_code: "legacy_timeout" },
  ])("requires a recognized failure code %#", (overrides) => {
    expect(nextRecoveryAction({
      attempts: [{
        ...attempt(1, "original"),
        ...overrides,
      } as unknown as WorkflowAttempt],
      abortSource: "coordinator",
    })).toEqual({ kind: "return_commander" });
  });

  it.each([
    [attempt(1, null, "anonymous_worker")],
    [attempt(1, "original"), attempt(2, "fallback")],
    [
      attempt(1, "original", "agent", "dependency_failed"),
      attempt(2, "original"),
    ],
    [attempt(1, "original"), attempt(2, "original"), attempt(3, "original")],
    [
      attempt(1, "original", "agent", "dependency_failed"),
      attempt(2, "fallback", "agent", "runtime_failed"),
      attempt(3, "original", "agent", "runtime_failed"),
    ],
    [
      attempt(1, "original", "agent", "dependency_failed"),
      attempt(2, "fallback-a", "agent", "runtime_failed"),
      attempt(3, "fallback-b", "agent", "runtime_failed"),
    ],
    [
      attempt(1, "original", "agent", "dependency_failed"),
      attempt(2, null, "anonymous_worker", "runtime_failed"),
      attempt(3, "fallback", "agent", "runtime_failed"),
    ],
    [
      attempt(1, "original"),
      { ...attempt(2, "original"), attempt: 3 },
    ],
    [
      attempt(1, "original", "agent", "dependency_failed"),
      { ...attempt(2, null, "anonymous_worker"), actor_id: "runtime-worker" },
    ],
  ])("fails safe for impossible recovery ordering %#", (attempts) => {
    expect(nextRecoveryAction({
      attempts: attempts as WorkflowAttempt[],
      abortSource: "coordinator",
    })).toEqual({ kind: "return_commander" });
  });

  it("accepts a direct named fallback after a non-retryable original failure", () => {
    expect(nextRecoveryAction({
      attempts: [
        attempt(1, "original", "agent", "dependency_failed"),
        attempt(2, "fallback", "agent", "runtime_failed"),
      ],
      abortSource: "coordinator",
    })).toEqual({ kind: "run_anonymous" });
  });

  it.each([
    null,
    {},
    [null],
    [{ attempt: "one", actor_id: "original", actor_kind: "agent", status: "failed" }],
    [{ attempt: 1, actor_id: "original", actor_kind: "worker", status: "failed" }],
    [{ attempt: 1, actor_id: "original", actor_kind: "agent", status: "cancelled" }],
  ])("fails safe for malformed or legacy attempts %#", (attempts) => {
    const action = nextRecoveryAction({
      attempts: attempts as unknown as WorkflowAttempt[],
      abortSource: "coordinator",
    });
    expect(action).toEqual({ kind: "return_commander" });
    expect(action.kind).not.toBe("retry_same");
  });
});

describe("fallback agent ranking", () => {
  it("gives an explicit required skill the decisive +50 score", () => {
    const result = selectFallbackAgent({
      task: "prepare the release",
      requiredCapabilities: ["security-review"],
      members: [member("generalist"), member("reviewer")],
      agents: [
        agent("generalist", { category: "release" }),
        agent("reviewer", { skill_list: [" SECURITY-REVIEW "] }),
      ],
      failedActorIds: new Set(),
      busyActorIds: new Set(),
    });

    expect(result?.actor.id).toBe("reviewer");
    expect(result?.score).toBe(50);
  });

  it("stacks required-capability and category matches deterministically", () => {
    const result = selectFallbackAgent({
      task: "unrelated work",
      requiredCapabilities: ["review"],
      members: [member("reviewer")],
      agents: [agent("reviewer", { category: " Review " })],
      failedActorIds: new Set(),
      busyActorIds: new Set(),
    });

    expect(result?.score).toBe(75);
  });

  it("awards +25 when category matches a task token", () => {
    const result = selectFallbackAgent({
      task: "review the implementation",
      requiredCapabilities: [],
      members: [member("reviewer")],
      agents: [agent("reviewer", { category: "REVIEW" })],
      failedActorIds: new Set(),
      busyActorIds: new Set(),
    });

    expect(result?.score).toBe(25);
  });

  it("caps text and skill task-token scoring at +20 each", () => {
    const result = selectFallbackAgent({
      task: "alpha beta gamma delta epsilon zeta",
      requiredCapabilities: [],
      members: [member("matcher")],
      agents: [agent("matcher", {
        name: "alpha beta",
        description_en: "gamma delta",
        workflow: "epsilon zeta",
        skill_list: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"],
      })],
      failedActorIds: new Set(),
      busyActorIds: new Set(),
    });

    expect(result?.score).toBe(40);
  });

  it("adds the runtime bonus only at five attempts and an 0.8 success ratio", () => {
    const base = {
      task: "alpha beta gamma delta",
      requiredCapabilities: [],
      members: [member("below-sample"), member("below-ratio"), member("boundary")],
      failedActorIds: new Set<string>(),
      busyActorIds: new Set<string>(),
    };
    const result = selectFallbackAgent({
      ...base,
      agents: [
        agent("below-sample", {
          workflow: "alpha beta gamma delta",
          runtime_stats: {
            attempts: 4,
            successes: 4,
          } as Agent["runtime_stats"],
        }),
        agent("below-ratio", {
          workflow: "alpha beta gamma delta",
          runtime_stats: {
            attempts: 5,
            successes: 3,
          } as Agent["runtime_stats"],
        }),
        agent("boundary", {
          workflow: "alpha beta gamma delta",
          runtime_stats: {
            attempts: 5,
            successes: 4,
          } as Agent["runtime_stats"],
        }),
      ],
    });

    expect(result?.actor.id).toBe("boundary");
    expect(result?.score).toBe(25);
  });

  it("excludes non-agents, disabled, failed, busy, missing, unreadable, and mismatched specs", () => {
    const unreadable = {
      ...agent("unreadable"),
      name: 42,
    } as unknown as Agent;
    const result = selectFallbackAgent({
      task: "review implementation",
      requiredCapabilities: ["review"],
      members: [
        member("commander", "commander"),
        member("disabled"),
        member("failed"),
        member("busy"),
        member("missing"),
        member("unreadable"),
        member("mismatch"),
        member("eligible"),
      ],
      agents: [
        agent("disabled", { enabled: false, skill_list: ["review"] }),
        agent("failed", { skill_list: ["review"] }),
        agent("busy", { skill_list: ["review"] }),
        unreadable,
        agent("different-id", { skill_list: ["review"] }),
        agent("eligible", { skill_list: ["review"] }),
      ],
      failedActorIds: new Set(["failed"]),
      busyActorIds: new Set(["busy"]),
    });

    expect(result?.actor.id).toBe("eligible");
  });

  it("returns null below the default minimum score and honors an explicit threshold", () => {
    const input = {
      task: "unmatched capability",
      requiredCapabilities: ["nonexistent"],
      members: [member("generalist")],
      agents: [agent("generalist")],
      failedActorIds: new Set<string>(),
      busyActorIds: new Set<string>(),
    };

    expect(selectFallbackAgent(input)).toBeNull();
    expect(selectFallbackAgent({
      ...input,
      agents: [agent("generalist", { skill_list: ["nonexistent"] })],
      minimumScore: 100,
    })).toBeNull();
  });

  it("matches Chinese two-character runs", () => {
    const result = selectFallbackAgent({
      task: "代码审查实现",
      requiredCapabilities: [],
      members: [member("zh-reviewer")],
      agents: [agent("zh-reviewer", {
        description_zh: "负责代码审查实现",
      })],
      failedActorIds: new Set(),
      busyActorIds: new Set(),
    });

    expect(result?.score).toBe(20);
  });

  it("deduplicates members and candidate specs while breaking ties by agent_id", () => {
    const input = {
      task: "review implementation carefully thoroughly",
      requiredCapabilities: [],
      members: [member("b-agent"), member("a-agent"), member("b-agent")],
      agents: [
        agent("b-agent", { workflow: "review implementation carefully thoroughly" }),
        agent("a-agent", { workflow: "review implementation carefully thoroughly" }),
        agent("b-agent", { workflow: "review implementation carefully thoroughly" }),
      ],
      failedActorIds: new Set<string>(),
      busyActorIds: new Set<string>(),
    };

    expect(selectFallbackAgent(input)?.actor.id).toBe("a-agent");
    expect(selectFallbackAgent({
      ...input,
      members: [...input.members].reverse(),
      agents: [...input.agents].reverse(),
    })?.actor.id).toBe("a-agent");
  });

  it("selects the same canonical spec when duplicate agent ids have equal scores", () => {
    const alphaSpec = agent("duplicate", {
      name: "same-name",
      workflow: "alpha beta gamma delta first",
    });
    const omegaSpec = agent("duplicate", {
      name: "same-name",
      workflow: "alpha beta gamma delta second",
    });
    const input = {
      task: "alpha beta gamma delta",
      requiredCapabilities: [],
      members: [member("duplicate")],
      failedActorIds: new Set<string>(),
      busyActorIds: new Set<string>(),
    };

    expect(selectFallbackAgent({
      ...input,
      agents: [omegaSpec, alphaSpec],
    })?.agent.workflow).toBe(alphaSpec.workflow);
    expect(selectFallbackAgent({
      ...input,
      agents: [alphaSpec, omegaSpec],
    })?.agent.workflow).toBe(alphaSpec.workflow);
  });

  it("canonicalizes the complete Agent spec for equal-score duplicate ids", () => {
    const firstSpec = agent("duplicate-full", {
      name: "same-name",
      workflow: "alpha beta gamma delta",
      source: "custom",
      created_at: "2026-07-30T00:00:00.000Z",
      updated_at: "2026-07-30T00:00:00.000Z",
      icon: "alpha-icon",
      runtime_stats: {
        attempts: 5,
        successes: 4,
        deliveries: 4,
        failures: 1,
        errors: 0,
        total_duration_ms: 100,
        successful_duration_ms: 80,
      },
      profile: { role: "alpha-role" },
    });
    const secondSpec = agent("duplicate-full", {
      name: "same-name",
      workflow: "alpha beta gamma delta",
      source: "marketplace",
      created_at: "2026-07-31T00:00:00.000Z",
      updated_at: "2026-07-31T00:00:00.000Z",
      icon: "omega-icon",
      runtime_stats: {
        attempts: 5,
        successes: 4,
        deliveries: 3,
        failures: 2,
        errors: 0,
        total_duration_ms: 200,
        successful_duration_ms: 120,
      },
      profile: { role: "omega-role" },
    });
    const input = {
      task: "alpha beta gamma delta",
      requiredCapabilities: [],
      members: [member("duplicate-full")],
      failedActorIds: new Set<string>(),
      busyActorIds: new Set<string>(),
    };

    const forward = selectFallbackAgent({
      ...input,
      agents: [firstSpec, secondSpec],
    });
    const reversed = selectFallbackAgent({
      ...input,
      agents: [secondSpec, firstSpec],
    });

    expect(forward?.agent).toEqual(reversed?.agent);
    expect(forward?.score).toBe(25);
  });

  it("excludes circular and oversized duplicate specs without throwing or order dependence", () => {
    const valid = agent("bounded", { workflow: "alpha beta gamma delta" });
    const circular = agent("bounded", { workflow: "alpha beta gamma delta" });
    const circularProfile: Record<string, unknown> = {};
    circularProfile.self = circularProfile;
    circular.profile = circularProfile as Agent["profile"];

    const oversized = agent("bounded", { workflow: "alpha beta gamma delta" });
    oversized.profile = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [`field_${index}`, index]),
    ) as Agent["profile"];

    const input = {
      task: "alpha beta gamma delta",
      requiredCapabilities: [],
      members: [member("bounded")],
      failedActorIds: new Set<string>(),
      busyActorIds: new Set<string>(),
    };

    expect(() => selectFallbackAgent({
      ...input,
      agents: [circular, oversized, valid],
    })).not.toThrow();
    expect(selectFallbackAgent({
      ...input,
      agents: [circular, oversized, valid],
    })?.agent).toEqual(valid);
    expect(selectFallbackAgent({
      ...input,
      agents: [valid, oversized, circular],
    })?.agent).toEqual(valid);
  });

  it("rejects known-field accessors without invoking getter side effects", () => {
    let getterCalls = 0;
    const accessored = agent("accessor", { workflow: "alpha beta gamma delta" });
    Object.defineProperty(accessored, "name", {
      configurable: true,
      enumerable: false,
      get() {
        getterCalls += 1;
        return getterCalls % 2 === 0 ? "varying-b" : "varying-a";
      },
    });
    const valid = agent("accessor", {
      name: "stable-name",
      workflow: "alpha beta gamma delta",
    });
    const input = {
      task: "alpha beta gamma delta",
      requiredCapabilities: [],
      members: [member("accessor")],
      failedActorIds: new Set<string>(),
      busyActorIds: new Set<string>(),
    };

    expect(selectFallbackAgent({
      ...input,
      agents: [accessored, valid],
    })?.agent.name).toBe("stable-name");
    expect(selectFallbackAgent({
      ...input,
      agents: [valid, accessored],
    })?.agent.name).toBe("stable-name");
    expect(getterCalls).toBe(0);
  });

  it("scores a verified data-property snapshot without invoking proxy get traps", () => {
    let getCalls = 0;
    const target = agent("proxy-data", { workflow: "alpha beta gamma delta" });
    const proxied = new Proxy(target, {
      get() {
        getCalls += 1;
        throw new Error("direct field reads are forbidden");
      },
    });

    const result = selectFallbackAgent({
      task: "alpha beta gamma delta",
      requiredCapabilities: [],
      members: [member("proxy-data")],
      agents: [proxied],
      failedActorIds: new Set(),
      busyActorIds: new Set(),
    });

    expect(result?.agent.agent_id).toBe("proxy-data");
    expect(result?.score).toBe(20);
    expect(getCalls).toBe(0);
  });

  it("ignores huge unknown root fields without requesting a whole-object key list", () => {
    const target = agent("large-root", { workflow: "alpha beta gamma delta" }) as Agent & Record<string, unknown>;
    for (let index = 0; index < 20_000; index += 1) {
      target[`unknown_${index}`] = index;
    }
    let ownKeysCalls = 0;
    const proxied = new Proxy(target, {
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("whole-object enumeration is forbidden");
      },
    });

    const result = selectFallbackAgent({
      task: "alpha beta gamma delta",
      requiredCapabilities: [],
      members: [member("large-root")],
      agents: [proxied],
      failedActorIds: new Set(),
      busyActorIds: new Set(),
    });

    expect(result?.agent.agent_id).toBe("large-root");
    expect(result?.score).toBe(20);
    expect(ownKeysCalls).toBe(0);
  });

  it("catches descriptor reflection errors and excludes the malformed duplicate", () => {
    const malformed = new Proxy(
      agent("reflect", { workflow: "alpha beta gamma delta" }),
      {
        getOwnPropertyDescriptor(_target, property) {
          if (property === "name") throw new Error("descriptor failure");
          return Reflect.getOwnPropertyDescriptor(_target, property);
        },
      },
    );
    const valid = agent("reflect", { workflow: "alpha beta gamma delta" });
    const input = {
      task: "alpha beta gamma delta",
      requiredCapabilities: [],
      members: [member("reflect")],
      failedActorIds: new Set<string>(),
      busyActorIds: new Set<string>(),
    };

    expect(() => selectFallbackAgent({
      ...input,
      agents: [malformed, valid],
    })).not.toThrow();
    expect(selectFallbackAgent({
      ...input,
      agents: [malformed, valid],
    })?.agent).toEqual(valid);
    expect(selectFallbackAgent({
      ...input,
      agents: [valid, malformed],
    })?.agent).toEqual(valid);
  });

  it("fails safe for malformed fields without coercing hostile values", () => {
    const hostile = {
      toString() {
        throw new Error("must not stringify malformed input");
      },
    };

    expect(() => selectFallbackAgent({
      task: hostile as unknown as string,
      requiredCapabilities: [hostile as unknown as string],
      members: [member("broken")],
      agents: [{
        ...agent("broken"),
        skill_list: [hostile as unknown as string],
        runtime_stats: {
          attempts: Number.POSITIVE_INFINITY,
          successes: Number.NaN,
        } as Agent["runtime_stats"],
      }],
      failedActorIds: new Set(),
      busyActorIds: new Set(),
    })).not.toThrow();

    expect(selectFallbackAgent({
      task: hostile as unknown as string,
      requiredCapabilities: [hostile as unknown as string],
      members: [member("broken")],
      agents: [{
        ...agent("broken"),
        skill_list: [hostile as unknown as string],
      }],
      failedActorIds: new Set(),
      busyActorIds: new Set(),
    })).toBeNull();
  });
});
