import { describe, expect, it, vi } from "vitest";

import {
  CreatorAgentError,
  runCreatorAgent,
  type CreatorAgentServiceDependencies,
} from "../../../../src/main/features/creator/creator-agent-service";
import type { CreatorCapabilityDescriptor } from "../../../../src/main/features/creator/catalog";
import type { CreatorPresetDraft } from "../../../../src/main/features/creator/store";
import type { CreatorPresetManifestV1 } from "../../../../src/main/features/creator/types";

const catalog: CreatorCapabilityDescriptor[] = [
  {
    capabilityId: "model.provider-main.deepseek-chat",
    version: "1",
    kind: "model",
    displayName: "Configured model",
    available: true,
    permissions: ["cost"],
    sourceRef: "provider.provider-main",
    health: "ready",
  },
  {
    capabilityId: "tool.file",
    version: "1",
    kind: "tool",
    displayName: "Files",
    available: true,
    permissions: ["read"],
    sourceRef: "agent-capability.file",
    health: "ready",
  },
];

function manifest(): CreatorPresetManifestV1 {
  return {
    schemaVersion: 1,
    presetId: "release-gate",
    version: "1.0.0",
    displayName: "Release gate reviewer",
    description: "Reviews a release without side effects.",
    presetType: "cogseed-agent",
    model: { providerId: "provider-main", modelId: "deepseek-chat" },
    capabilities: [{ capabilityId: "tool.file", version: "1" }],
    prompt: { systemSections: ["release.review"] },
    runtime: {
      sessionPolicy: "new-per-run",
      memoryPolicy: "read-only",
      loopPolicy: "single-agent",
      sandboxProfile: "creator-read-only-v1",
      timeoutMs: 30_000,
      budget: {},
    },
    permissions: {
      tools: ["tool.file"],
      files: ["workspace.readonly"],
      sideEffects: [],
      approvalMode: "always",
    },
    provenance: {
      createdBy: "user",
      sourceSessionId: "untrusted",
      sourceAssetRefs: ["ignored"],
    },
  };
}

function dependencies(output: string): CreatorAgentServiceDependencies {
  const saved: CreatorPresetDraft[] = [];
  return {
    chatWithModel: vi.fn(async () => ({
      ok: true,
      text: output,
      error: "",
      aborted: false,
    })),
    buildCatalog: vi.fn(async () => catalog),
    inspect: vi.fn(async () => ({
      schemaVersion: 1,
      flags: { creatorMode: true, publish: true },
      capabilities: catalog,
      peers: [],
      sandboxProfiles: ["creator-read-only-v1"] as ["creator-read-only-v1"],
      limits: { maxCapabilities: 64 },
    })),
    saveDraft: vi.fn(async (_userId, draft) => {
      saved.push(draft);
      return draft;
    }),
    listPresets: vi.fn(async () => []),
    simulate: vi.fn(),
    verify: vi.fn(),
    now: () => "2026-08-25T00:00:00.000Z",
    createId: () => "turn-0001",
    getLocale: () => "en",
  };
}

describe("Creator Agent orchestration service", () => {
  it("runs a constrained ephemeral model turn and saves a validated draft only", async () => {
    const output = JSON.stringify({
      status: "draft_ready",
      message: "Draft prepared for review.",
      manifest: manifest(),
      checks: [
        { checkId: "typecheck", status: "skipped", summary: "Not run." },
      ],
    });
    const deps = dependencies(output);

    const result = await runCreatorAgent(
      "user-1",
      {
        goal: "Create a release gate reviewer that reads code and runs typecheck.",
        sourceSessionId: "chat-session-1",
        projectId: "project-1",
        cid: "cid-1",
      },
      deps,
    );

    expect(result.status).toBe("draft_ready");
    expect(result.draft?.manifest.provenance).toEqual({
      createdBy: "creator-agent",
      sourceSessionId: "chat-session-1",
      sourceAssetRefs: [],
    });
    expect(deps.saveDraft).toHaveBeenCalledTimes(1);
    expect(deps.simulate).not.toHaveBeenCalled();
    expect(deps.verify).not.toHaveBeenCalled();

    const call = (deps.chatWithModel as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(call).toMatchObject({
      userId: "user-1",
      sessionId: "creator-turn-0001",
      ephemeralSession: true,
      toolAccess: "creator-read-only",
    });
    expect(call.systemPrompt).toContain("exactly one JSON envelope");
    expect(call.message).toContain("release gate reviewer");
    expect(call.systemPrompt).toContain("tool.file");
    expect(call.systemPrompt).not.toMatch(/\/Users\/|authorization|base.?url/i);
  });

  it("accepts a plain manifest as a draft_ready compatibility response", async () => {
    const deps = dependencies(JSON.stringify(manifest()));
    const result = await runCreatorAgent(
      "user-1",
      {
        goal: "Create a release gate reviewer.",
        sourceSessionId: "session-2",
      },
      deps,
    );
    expect(result.status).toBe("draft_ready");
    expect(result.draft?.manifest.presetId).toBe("release-gate");
  });

  it("returns clarification without saving when the model identifies high-risk ambiguity", async () => {
    const deps = dependencies(
      JSON.stringify({
        status: "needs_clarification",
        message: "Approval is needed.",
        clarification: {
          question: "Should this use network access?",
          reason: "The goal is ambiguous.",
          risk: "high",
        },
      }),
    );
    const result = await runCreatorAgent(
      "user-1",
      {
        goal: "Create a research reviewer.",
        sourceSessionId: "session-3",
      },
      deps,
    );
    expect(result.status).toBe("needs_clarification");
    expect(result.clarification?.risk).toBe("high");
    expect(deps.saveDraft).not.toHaveBeenCalled();
  });

  it.each([
    ["https://example.invalid", "creator_agent_forbidden_output"],
    ["Bearer abcdefghijk", "creator_agent_forbidden_output"],
    ["Authorization: Basic abcdefghijk", "creator_agent_forbidden_output"],
    ["socketHandle=abc", "creator_agent_forbidden_output"],
    ["npm run typecheck", "creator_agent_forbidden_output"],
  ])("rejects model output containing %s", async (unsafe, code) => {
    const deps = dependencies(
      JSON.stringify({
        status: "blocked",
        message: unsafe,
      }),
    );
    await expect(
      runCreatorAgent(
        "user-1",
        {
          goal: "Create a safe reviewer.",
          sourceSessionId: "session-4",
        },
        deps,
      ),
    ).rejects.toMatchObject({ message: code });
    expect(deps.saveDraft).not.toHaveBeenCalled();
  });

  it("rejects malformed or multiple JSON envelopes", async () => {
    const deps = dependencies(
      '{"status":"blocked","message":"one"}\n{"status":"blocked","message":"two"}',
    );
    await expect(
      runCreatorAgent(
        "user-1",
        {
          goal: "Create a safe reviewer.",
          sourceSessionId: "session-5",
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(CreatorAgentError);
  });
});

describe("Creator Agent capability planning policy", () => {
  function emptyManifest(): CreatorPresetManifestV1 {
    const value = manifest();
    return {
      ...value,
      capabilities: [],
      permissions: {
        tools: [],
        files: [],
        sideEffects: [],
        approvalMode: "always",
      },
      prompt: {
        systemSections: [
          "Reviews submitted text. Stop on missing input. Use fallback when review fails.",
        ],
      },
    };
  }

  it("returns an explicit direct plan for a pure text agent", async () => {
    const base = emptyManifest();
    const deps = dependencies(
      JSON.stringify({
        status: "draft_ready",
        message: "Draft prepared.",
        manifest: base,
        capability_plan: {
          tools: [],
          skills: [],
          riskLevel: "low",
          creationMode: "direct",
        },
      }),
    );
    const result = await runCreatorAgent(
      "user-1",
      {
        goal: "Create a text reviewer with no tools.",
        sourceSessionId: "plan-1",
      },
      deps,
    );
    expect(result.capabilityPlan).toEqual({
      tools: [],
      skills: [],
      riskLevel: "low",
      creationMode: "direct",
    });
  });

  it("rejects a capability that violates an explicit no-tools restriction", async () => {
    const base = manifest();
    const deps = dependencies(
      JSON.stringify({
        status: "draft_ready",
        message: "Draft prepared.",
        manifest: base,
        capability_plan: {
          tools: [
            {
              id: "tool.file",
              kind: "tool",
              version: "1",
              reason: "Read files.",
              required: true,
              network: false,
              sideEffects: [],
              riskLevel: "medium",
              dependencies: [],
            },
          ],
          skills: [],
          riskLevel: "medium",
          creationMode: "governed",
        },
      }),
    );
    await expect(
      runCreatorAgent(
        "user-1",
        { goal: "Create a reviewer. No tools.", sourceSessionId: "plan-2" },
        deps,
      ),
    ).rejects.toMatchObject({
      message: "creator_agent_capability_conflicts_with_goal",
    });
  });

  it("rejects a capability plan that is not aligned with the workflow", async () => {
    const base = manifest();
    base.prompt = {
      systemSections: [
        "Reviews release notes. Stop on missing input. Use fallback on failure.",
      ],
    };
    const deps = dependencies(
      JSON.stringify({
        status: "draft_ready",
        message: "Draft prepared.",
        manifest: base,
        capability_plan: {
          tools: [
            {
              id: "tool.file",
              kind: "tool",
              version: "1",
              reason: "Read files.",
              required: true,
              network: false,
              sideEffects: [],
              riskLevel: "medium",
              dependencies: [],
            },
          ],
          skills: [],
          riskLevel: "medium",
          creationMode: "governed",
        },
      }),
    );
    await expect(
      runCreatorAgent(
        "user-1",
        { goal: "Create a release reviewer.", sourceSessionId: "plan-3" },
        deps,
      ),
    ).rejects.toMatchObject({
      message: "creator_agent_capability_plan_mismatch",
    });
  });

  it("forces governed mode for read capabilities even when the model asks for direct", async () => {
    const base = manifest();
    base.prompt = {
      systemSections: [
        "Read file input and review it. Stop on missing input. Use fallback on failure.",
      ],
    };
    const deps = dependencies(
      JSON.stringify({
        status: "draft_ready",
        message: "Draft prepared.",
        manifest: base,
        capability_plan: {
          tools: [
            {
              id: "tool.file",
              kind: "tool",
              version: "1",
              reason: "Read file input.",
              required: true,
              network: false,
              sideEffects: [],
              riskLevel: "medium",
              dependencies: [],
            },
          ],
          skills: [],
          riskLevel: "medium",
          creationMode: "direct",
        },
      }),
    );
    await expect(
      runCreatorAgent(
        "user-1",
        { goal: "Create a file reviewer.", sourceSessionId: "plan-4" },
        deps,
      ),
    ).rejects.toMatchObject({
      message: "creator_agent_capability_plan_invalid",
    });
  });

  it("rejects capability plans with a non-boolean required flag", async () => {
    const base = manifest();
    base.prompt = { systemSections: ["Read tool.file input and review it."] };
    const deps = dependencies(
      JSON.stringify({
        status: "draft_ready",
        message: "Draft prepared.",
        manifest: base,
        capability_plan: {
          tools: [
            {
              id: "tool.file",
              kind: "tool",
              version: "1",
              reason: "Read file input.",
              required: "true",
              network: false,
              sideEffects: [],
              riskLevel: "medium",
              dependencies: [],
            },
          ],
          skills: [],
          riskLevel: "medium",
          creationMode: "governed",
        },
      }),
    );
    await expect(
      runCreatorAgent(
        "user-1",
        { goal: "Create a file reviewer.", sourceSessionId: "plan-6" },
        deps,
      ),
    ).rejects.toMatchObject({ message: "creator_agent_capability_plan_invalid" });
  });

  it("rejects unsafe capability-plan text before saving a draft", async () => {
    const base = emptyManifest();
    const deps = dependencies(
      JSON.stringify({
        status: "draft_ready",
        message: "Draft prepared.",
        manifest: base,
        capability_plan: {
          tools: [],
          skills: [],
          riskLevel: "low",
          creationMode: "direct",
          note: "https://unsafe.invalid",
        },
      }),
    );
    await expect(
      runCreatorAgent(
        "user-1",
        { goal: "Create a text reviewer.", sourceSessionId: "plan-5" },
        deps,
      ),
    ).rejects.toMatchObject({ message: "creator_agent_forbidden_output" });
    expect(deps.saveDraft).not.toHaveBeenCalled();
  });
});
