#!/usr/bin/env node
// ============================================================
// NSEAP Meta-Skill Engine — MCP Server Entry Point
// The capability evolution control plane for enterprise agents
// ============================================================

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { OntologyReader } from './modules/ontology-reader.js';
import { EvidenceCollector } from './modules/evidence-collector.js';
import { AttributionEngine } from './modules/attribution-engine.js';
import { PatchGenerator } from './modules/patch-generator.js';
import { GovernanceGates } from './modules/governance-gates.js';
import { SkillCreator } from './modules/skill-creator.js';
import { RegistryManager } from './modules/registry-manager.js';
import { ENGINE_CONFIG } from './config/engine-config.js';
import type { InteractionContext } from './types/index.js';
import { stableHash } from './persistence/canonical-json.js';
import { KstarState } from './persistence/kstar-state.js';

// ── Engine Info ─────────────────────────────────────────────
export interface EngineInfo {
  engine_name: string;
  engine_version: string;
  protocol_version: string;
  version: string;
  snapshot_hash: string;
  capabilities: string[];
}

export function getEngineInfo(): EngineInfo {
  const capabilities = [
    'generation_cas',
    'idempotent_evidence',
    'ontology_reader',
    'snapshot_migration',
    'legacy_import',
    'kstar_attribution',
    'patch_generation',
    'governance_gates'
  ];

  return {
    engine_name: 'nseap-meta-skill-engine',
    engine_version: '1.0.0',
    protocol_version: '1.0',
    version: '1.0.0',
    snapshot_hash: stableHash({ version: '1.0.0', capabilities }),
    capabilities
  };
}

// ── Initialize Modules ──────────────────────────────────────
const ontologyReader = new OntologyReader(process.env.NSEAP_ONTOLOGY_DIR ?? './ontologies');
const evidenceCollector = new EvidenceCollector();
const attributionEngine = new AttributionEngine();
const patchGenerator = new PatchGenerator();
const governanceGates = new GovernanceGates();
const skillCreator = new SkillCreator();
const registry = new RegistryManager();
// KSTAR state the PC round-trips via snapshot_import / snapshot_export.
const kstarState = new KstarState();

// ── MCP Server ──────────────────────────────────────────────
const server = new Server(
  {
    name: 'nseap-meta-skill-engine',
    // Matches package.json and the version get_engine_info reports. MCP clients
    // read serverInfo.version, so a stale value here would make any future
    // capability gate see an older engine than the one actually running.
    version: '1.0.0',
    description: 'NSEAP Meta-Skill Engine — reads ontology, captures interactions, evolves skills via KSTAR',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// ── Tool: List all available tools ──────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_engine_info',
      description: 'Get engine version, protocol, hash, and capabilities.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'read_ontology',
      description: 'Read an ontology package (TBox/RBox/ABox) by ID. Returns the full ontology slice.',
      inputSchema: {
        type: 'object',
        properties: {
          ontology_id: { type: 'string', description: 'Ontology identifier (e.g., "traffic_fee_dispute")' },
          version: { type: 'string', description: 'Optional version (defaults to latest)' },
        },
        required: ['ontology_id'],
      },
    },
    {
      name: 'list_ontologies',
      description: 'List all available ontology packages in the registry.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'extract_ontology_slice',
      description: 'Extract a scoped subset of an ontology (specific classes, rules, or examples).',
      inputSchema: {
        type: 'object',
        properties: {
          ontology_id: { type: 'string' },
          class_ids: { type: 'array', items: { type: 'string' }, description: 'Filter by class IDs' },
          rule_ids: { type: 'array', items: { type: 'string' }, description: 'Filter by rule IDs' },
          example_types: { type: 'array', items: { type: 'string' }, description: 'Filter by example type' },
        },
        required: ['ontology_id'],
      },
    },
    {
      name: 'capture_interaction',
      description: 'Capture a user-agent interaction and generate a KSTAR Episode. Records K/S/T/A/R five-tuple.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          user_id: { type: 'string' },
          user_query: { type: 'string' },
          agent_id: { type: 'string' },
          matched_skill_id: { type: 'string' },
          matched_skill_name: { type: 'string' },
          ontology_refs: { type: 'array', items: { type: 'string' } },
          predicted_action: { type: 'string', description: 'What the agent planned to do (Â)' },
          predicted_result: { type: 'string', description: 'What the agent predicted would happen (R̂)' },
          actual_action: { type: 'string', description: 'What the agent actually did' },
          actual_result: { type: 'string', description: 'What actually happened' },
        },
        required: ['session_id', 'user_query', 'predicted_action', 'predicted_result', 'actual_action', 'actual_result'],
      },
    },
    {
      name: 'query_episodes',
      description: 'Query KSTAR Episodes by session, skill, or delta threshold.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          min_delta_r: { type: 'number', description: 'Minimum absolute DeltaR threshold' },
          delta_a_gate: { type: 'string', enum: ['pass', 'warn', 'fail'] },
        },
      },
    },
    {
      name: 'analyze_attribution',
      description: 'Run attribution analysis on a KSTAR Episode. Identifies root cause (TBox/RBox/ABox/Skill/...) and recommends action.',
      inputSchema: {
        type: 'object',
        properties: {
          episode_id: { type: 'string', description: 'The KSTAR Episode to analyze' },
        },
        required: ['episode_id'],
      },
    },
    {
      name: 'analyze_no_match',
      description: '分析"无匹配 Skill"的交互。当 Agent 找不到对应 Skill 时，触发此分析 → 自动推荐 create_skill。',
      inputSchema: {
        type: 'object',
        properties: {
          episode_id: { type: 'string', description: '匹配不到 Skill 的 Episode' },
        },
        required: ['episode_id'],
      },
    },
    {
      name: 'route_recommendation',
      description: '根据归因结果路由到正确的动作：create_skill / propose_patch / propose_ontology_patch / no_action。',
      inputSchema: {
        type: 'object',
        properties: {
          attribution_id: { type: 'string' },
        },
        required: ['attribution_id'],
      },
    },
    {
      name: 'propose_patch',
      description: 'Generate a bounded patch proposal from an attribution. Enforces edit budget <= 2 operations.',
      inputSchema: {
        type: 'object',
        properties: {
          attribution_id: { type: 'string' },
          target_id: { type: 'string' },
          target_version: { type: 'string' },
          current_content: { type: 'string' },
          proposed_content: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['attribution_id', 'target_id', 'target_version', 'current_content', 'proposed_content'],
      },
    },
    {
      name: 'run_governance',
      description: 'Run the three-gate governance pipeline (Validation → Governance → Canary) on a patch proposal.',
      inputSchema: {
        type: 'object',
        properties: {
          proposal_id: { type: 'string' },
        },
        required: ['proposal_id'],
      },
    },
    {
      name: 'human_review',
      description: 'Submit human review decision (approve/reject) for a staged patch.',
      inputSchema: {
        type: 'object',
        properties: {
          decision_id: { type: 'string' },
          approved: { type: 'boolean' },
          reviewer: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['decision_id', 'approved', 'reviewer', 'reason'],
      },
    },
    {
      name: 'create_skill',
      description: '【通道 1】用户主动创建新 SkillPackage。生成 NSEAP 16 制品骨架，人类填写 5 项关键内容。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          domain: { type: 'string' },
          ontology_refs: { type: 'array', items: { type: 'string' } },
          trigger_phrases: { type: 'array', items: { type: 'string' } },
          do_not_use_when: { type: 'array', items: { type: 'string' } },
          positive_examples: { type: 'array', items: { type: 'string' } },
          negative_examples: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'description', 'domain'],
      },
    },
    {
      name: 'create_skill_auto',
      description: '【通道 2】引擎自动触发创建 Skill。当 KSTAR 归因发现"无匹配 Skill"时，LLM 从交互历史总结意图并生成草稿。',
      inputSchema: {
        type: 'object',
        properties: {
          interaction_history: { type: 'array', items: { type: 'object' }, description: '触发创建的交互历史' },
          suggested_name: { type: 'string', description: '建议的技能名称' },
        },
        required: ['interaction_history'],
      },
    },
    {
      name: 'capture_intent',
      description: '采集技能意图（Interview）。在写 Skill 之前，结构化搞清楚"做什么、何时触发、输出格式、边界情况"。返回追问问题列表。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          purpose: { type: 'string', description: '技能要解决什么问题' },
          trigger_contexts: { type: 'array', items: { type: 'string' }, description: '触发场景' },
          output_format: { type: 'string', description: '输出格式' },
          edge_cases: { type: 'array', items: { type: 'string' }, description: '边界情况' },
          dependencies: { type: 'array', items: { type: 'string' }, description: '依赖工具/MCP' },
          examples: { type: 'array', items: { type: 'object' }, description: '输入输出示例' },
        },
        required: ['name', 'purpose', 'trigger_contexts', 'output_format'],
      },
    },
    {
      name: 'generate_eval_cases',
      description: '为 Skill 生成测试用例（evals.json）。从意图示例 + 本体 RBox 规则自动生成断言。',
      inputSchema: {
        type: 'object',
        properties: {
          skill_id: { type: 'string' },
          examples: { type: 'array', items: { type: 'object' }, description: '输入输出示例' },
          ontology_rules: { type: 'array', items: { type: 'object' }, description: '本体规则（用于生成断言）' },
          edge_cases: { type: 'array', items: { type: 'string' } },
        },
        required: ['skill_id'],
      },
    },
    {
      name: 'run_eval',
      description: '运行评估：有 Skill vs 无 Skill 基线对比。每个测试用例跑两遍，记录输出和时间。',
      inputSchema: {
        type: 'object',
        properties: {
          skill_id: { type: 'string' },
          skill_path: { type: 'string' },
          eval_cases: { type: 'array', items: { type: 'object' } },
        },
        required: ['skill_id', 'skill_path', 'eval_cases'],
      },
    },
    {
      name: 'grade_eval',
      description: '对评估结果逐条断言评分（PASS/FAIL）。返回 grading.json。',
      inputSchema: {
        type: 'object',
        properties: {
          skill_id: { type: 'string' },
          assertions: { type: 'array', items: { type: 'string' } },
        },
        required: ['skill_id', 'assertions'],
      },
    },
    {
      name: 'benchmark_skill',
      description: '聚合基准对比：有/无 Skill 的通过率、时间、token 对比。返回 benchmark.json + 模式分析。',
      inputSchema: {
        type: 'object',
        properties: {
          skill_id: { type: 'string' },
          target_pass_rate: { type: 'number', description: '目标通过率（默认 0.8）' },
        },
        required: ['skill_id'],
      },
    },
    {
      name: 'improve_skill',
      description: '根据反馈改进 Skill 草稿。应用反馈后自动重新评估，直到达标或用户手动停止。',
      inputSchema: {
        type: 'object',
        properties: {
          skill_id: { type: 'string' },
          feedback: { type: 'string', description: '改进反馈' },
        },
        required: ['skill_id', 'feedback'],
      },
    },
    {
      name: 'grade_eval_llm',
      description: '【增强】使用 LLM 语义理解进行评分（替代关键词匹配）。逐条断言评分 PASS/FAIL + evidence。',
      inputSchema: {
        type: 'object',
        properties: {
          skill_id: { type: 'string' },
          assertions: { type: 'array', items: { type: 'string' } },
        },
        required: ['skill_id', 'assertions'],
      },
    },
    {
      name: 'generate_eval_viewer',
      description: '【增强】生成 HTML 评估审查页面。可视化展示测试用例、输出对比、评分结果、基准数据。',
      inputSchema: {
        type: 'object',
        properties: {
          skill_id: { type: 'string' },
          output_path: { type: 'string', description: 'HTML 文件输出路径' },
        },
        required: ['skill_id'],
      },
    },
    {
      name: 'optimize_description',
      description: '【增强】优化 Skill 触发描述，提高触发准确率。生成测试查询 → 测触发率 → 改描述。',
      inputSchema: {
        type: 'object',
        properties: {
          skill_id: { type: 'string' },
          current_description: { type: 'string' },
        },
        required: ['skill_id', 'current_description'],
      },
    },
    {
      name: 'register_skill',
      description: 'Register a skill in the registry with version tracking.',
      inputSchema: {
        type: 'object',
        properties: {
          skill_id: { type: 'string' },
          skill_name: { type: 'string' },
          skill_version: { type: 'string' },
          skill_path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['skill_id', 'skill_name', 'skill_version', 'skill_path', 'content'],
      },
    },
    {
      name: 'list_registry',
      description: 'List all registered artifacts (skills, ontologies, episodes).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_engine_config',
      description: 'Get the current engine configuration (identity contract, guardrails, gates).',
      inputSchema: { type: 'object', properties: {} },
    },

    // ── KSTAR Snapshot Tools ────────────────────────────────
    // The PC-side CAS cycle in features/p3394/kstar-adapter.ts calls these.
    {
      name: 'snapshot_import',
      description: 'Load a KSTAR state snapshot into the engine, replacing in-memory state. Omit the snapshot to start from empty.',
      inputSchema: {
        type: 'object',
        properties: {
          snapshot: { type: 'object', description: 'Snapshot previously produced by snapshot_export' },
        },
      },
    },
    {
      name: 'snapshot_export',
      description: 'Export the current KSTAR state snapshot for the caller to persist.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'record_evidence',
      description: 'Record one execution evidence record, deduplicated by its stable id. Returns the updated snapshot so the caller can persist it.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Stable evidence id; repeat calls with the same id are deduplicated' },
          type: { type: 'string', description: 'Evidence kind, e.g. tool_cycle or agent_run_result' },
        },
        required: ['id'],
      },
    },
  ],
}));

// ── Tool: Handle tool calls ─────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'get_engine_info': {
        return jsonResponse(getEngineInfo());
      }

      // ── Ontology Tools ──────────────────────────────────
      case 'read_ontology': {
        const { ontology_id, version } = args as { ontology_id: string; version?: string };
        const result = await ontologyReader.loadOntology(ontology_id, version);
        return jsonResponse(result);
      }

      case 'list_ontologies': {
        const result = await ontologyReader.listOntologies();
        return jsonResponse(result);
      }

      case 'extract_ontology_slice': {
        const { ontology_id, class_ids, rule_ids, example_types } = args as {
          ontology_id: string; class_ids?: string[]; rule_ids?: string[]; example_types?: string[];
        };
        const { slice } = await ontologyReader.loadOntology(ontology_id);
        const scoped = ontologyReader.extractSlice(slice, { classIds: class_ids, ruleIds: rule_ids, exampleTypes: example_types as any });
        return jsonResponse(scoped);
      }

      // ── Evidence Tools ──────────────────────────────────
      case 'capture_interaction': {
        const a = args as any;
        const interaction: InteractionContext = {
          session_id: a.session_id,
          user_id: a.user_id ?? 'anonymous',
          user_query: a.user_query,
          agent_id: a.agent_id ?? 'company-agent',
          matched_skill_id: a.matched_skill_id ?? null,
          matched_skill_name: a.matched_skill_name ?? null,
          ontology_refs: a.ontology_refs ?? [],
          timestamp: new Date().toISOString(),
          conversation_history: [],
        };
        const episode = evidenceCollector.captureEpisode(
          interaction,
          { action_hat: a.predicted_action, result_hat: a.predicted_result },
          { action: a.actual_action, result: a.actual_result },
        );
        return jsonResponse(episode);
      }

      case 'query_episodes': {
        const { session_id, min_delta_r, delta_a_gate } = args as any;
        const episodes = evidenceCollector.queryEpisodes({
          session_id,
          min_delta_r,
          delta_a_gate,
        });
        return jsonResponse(episodes);
      }

      // ── Attribution Tools ────────────────────────────────
      case 'analyze_attribution': {
        const { episode_id } = args as { episode_id: string };
        const episode = evidenceCollector.getEpisode(episode_id);
        if (!episode) return errorResponse(`Episode not found: ${episode_id}`);
        const result = attributionEngine.analyze(episode);
        return jsonResponse(result);
      }

      case 'analyze_no_match': {
        const { episode_id } = args as { episode_id: string };
        const episode = evidenceCollector.getEpisode(episode_id);
        if (!episode) return errorResponse(`Episode not found: ${episode_id}`);
        const result = attributionEngine.analyzeNoMatch(episode);
        return jsonResponse(result);
      }

      case 'route_recommendation': {
        const { attribution_id } = args as { attribution_id: string };
        const record = attributionEngine.getRecords().find(r => r.attribution_id === attribution_id);
        if (!record) return errorResponse(`Attribution not found: ${attribution_id}`);
        const result = attributionEngine.routeRecommendation(record);
        return jsonResponse(result);
      }

      // ── Patch Tools ──────────────────────────────────────
      case 'propose_patch': {
        const a = args as any;
        const attribution = attributionEngine.getRecordByEpisode(a.attribution_id)
          ?? attributionEngine.getRecords().find(r => r.attribution_id === a.attribution_id);
        if (!attribution) return errorResponse(`Attribution not found: ${a.attribution_id}`);
        const result = patchGenerator.generate(attribution, {
          target_id: a.target_id,
          target_version: a.target_version,
          current_content: a.current_content,
          proposed_content: a.proposed_content,
          description: a.description ?? '',
        });
        return jsonResponse(result);
      }

      case 'run_governance': {
        const { proposal_id } = args as { proposal_id: string };
        const proposal = patchGenerator.getProposal(proposal_id);
        if (!proposal) return errorResponse(`Proposal not found: ${proposal_id}`);
        const result = await governanceGates.runGates(proposal);
        return jsonResponse(result);
      }

      case 'human_review': {
        const { decision_id, approved, reviewer, reason } = args as any;
        const result = governanceGates.humanReview(decision_id, approved, reviewer, reason);
        return jsonResponse(result);
      }

      // ── Skill-Creator Tools ──────────────────────────────
      case 'create_skill': {
        const a = args as any;
        const result = skillCreator.createDraft({
          name: a.name,
          description: a.description,
          domain: a.domain,
          ontology_refs: a.ontology_refs ?? [],
          trigger_phrases: a.trigger_phrases ?? [],
          do_not_use_when: a.do_not_use_when ?? [],
          positive_examples: a.positive_examples ?? [],
          negative_examples: a.negative_examples ?? [],
        });
        return jsonResponse(result);
      }

      // ── Skill-Creator Enhanced Tools ─────────────────────
      case 'create_skill_auto': {
        const a = args as any;
        const intent = await skillCreator.extractIntentFromHistory(a.interaction_history ?? []);
        const result = skillCreator.createDraftFromIntent(intent, a.suggested_name ?? 'auto-skill');
        return jsonResponse(result);
      }

      case 'capture_intent': {
        const a = args as any;
        const result = skillCreator.captureIntent({
          name: a.name,
          purpose: a.purpose,
          trigger_contexts: a.trigger_contexts,
          output_format: a.output_format,
          needs_test_cases: a.needs_test_cases,
          edge_cases: a.edge_cases,
          dependencies: a.dependencies,
          examples: a.examples,
        });
        return jsonResponse(result);
      }

      case 'generate_eval_cases': {
        const a = args as any;
        const draft = skillCreator.getDraft(a.skill_id);
        if (!draft) return errorResponse(`Draft not found: ${a.skill_id}`);
        const intent = draft.intent ?? {
          purpose: draft.skill_name,
          trigger_contexts: [],
          output_format: 'structured',
          needs_test_cases: true,
          edge_cases: a.edge_cases ?? [],
          dependencies: [],
          examples: (a.examples ?? []).map((e: any) => ({ input: e.input ?? '', expected_output: e.expected_output ?? '' })),
        };
        const evalCases = skillCreator.generateEvalCasesFromIntent(intent);
        const assertions = skillCreator.generateAssertionsFromRules(a.ontology_rules ?? []);
        return jsonResponse({ eval_cases: evalCases, auto_assertions: assertions });
      }

      case 'run_eval': {
        const a = args as any;
        const evalCases = (a.eval_cases ?? []).map((e: any, i: number) => ({
          id: e.id ?? i + 1,
          prompt: e.prompt,
          expected_output: e.expected_output ?? '',
          assertions: e.assertions ?? [],
        }));
        const result = await skillCreator.runEval(a.skill_id, evalCases, a.skill_path ?? '');
        return jsonResponse(result);
      }

      case 'grade_eval': {
        const a = args as any;
        const result = skillCreator.gradeEval(a.skill_id, a.assertions ?? []);
        const graded = Object.fromEntries(result);
        return jsonResponse(graded);
      }

      case 'benchmark_skill': {
        const a = args as any;
        const benchmark = skillCreator.aggregateBenchmark(a.skill_id);
        const stopCheck = skillCreator.shouldStopIteration(a.skill_id, a.target_pass_rate ?? 0.8);
        return jsonResponse({ benchmark, should_stop: stopCheck });
      }

      case 'improve_skill': {
        const a = args as any;
        const result = skillCreator.improveDraft(a.skill_id, a.feedback);
        return jsonResponse(result);
      }

      case 'grade_eval_llm': {
        const a = args as any;
        const result = skillCreator.gradeEvalWithLLM(a.skill_id, a.assertions ?? []);
        const graded = Object.fromEntries(result);
        return jsonResponse(graded);
      }

      case 'generate_eval_viewer': {
        const a = args as any;
        const html = await skillCreator.generateEvalViewer(a.skill_id);
        const outputPath = a.output_path ?? `./eval-viewer/${a.skill_id}-review.html`;
        try {
          const fs = await import('fs');
          const path = await import('path');
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, html, 'utf-8');
        } catch (e) { /* ignore write errors in demo */ }
        return jsonResponse({ html, output_path: outputPath });
      }

      case 'optimize_description': {
        const a = args as any;
        const result = skillCreator.optimizeDescription(a.skill_id, a.current_description);
        return jsonResponse(result);
      }

      // ── Registry Tools ───────────────────────────────────
      case 'register_skill': {
        const a = args as any;
        const entry = registry.registerSkill(
          { skill_id: a.skill_id, skill_name: a.skill_name, skill_version: a.skill_version, skill_path: a.skill_path, ontology_refs: [], status: 'draft', level: 5 },
          a.content,
        );
        return jsonResponse(entry);
      }

      case 'list_registry': {
        const result = registry.listAll();
        return jsonResponse(result);
      }

      // ── Config Tools ─────────────────────────────────────
      case 'get_engine_config': {
        return jsonResponse(ENGINE_CONFIG);
      }

      // ── KSTAR Snapshot Tools ─────────────────────────────
      case 'snapshot_import': {
        const { snapshot } = (args ?? {}) as { snapshot?: unknown };
        if (snapshot === undefined || snapshot === null) {
          kstarState.reset();
          const exported = kstarState.export();
          return jsonResponse({
            success: true,
            generation: exported.generation,
            evidence_count: exported.evidence.length,
          });
        }
        // A malformed snapshot is reported as a failed import, not a thrown
        // tool error: the PC aborts the CAS transaction and keeps its evidence
        // in the pending log rather than folding corrupt history forward.
        try {
          const { generation, evidence_count } = kstarState.import(snapshot);
          return jsonResponse({ success: true, generation, evidence_count });
        } catch (err: any) {
          return jsonResponse({ success: false, error: err.message ?? 'invalid snapshot' });
        }
      }

      case 'snapshot_export': {
        return jsonResponse({ success: true, snapshot: kstarState.export() });
      }

      case 'record_evidence': {
        try {
          const { deduplicated, generation } = kstarState.recordEvidence(args ?? {});
          return jsonResponse({
            success: true,
            deduplicated,
            generation,
            snapshot: kstarState.export(),
          });
        } catch (err: any) {
          return jsonResponse({ success: false, error: err.message ?? 'invalid evidence' });
        }
      }

      default:
        return errorResponse(`Unknown tool: ${name}`);
    }
  } catch (err: any) {
    return errorResponse(err.message ?? 'Internal error');
  }
});

// ── Helpers ─────────────────────────────────────────────────

function jsonResponse(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResponse(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

// ── Start Server ────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('NSEAP Meta-Skill Engine running on stdio');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
