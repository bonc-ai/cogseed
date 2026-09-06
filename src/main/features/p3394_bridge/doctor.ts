import type { P3394BridgeManifest } from './manifest';
import { validateP3394BridgeManifest } from './manifest';

/**
 * 检查条目映射的标准编号（指南 v1.1 §16 原型验收十五条 / §17 测试清单）。
 * 消费方仍按 name/status/reason 读取；ref 是增补字段（向后兼容）。
 */
export interface P3394DoctorCheck { name: string; status: 'pass' | 'fail' | 'warn'; reason?: string; ref?: string }
export interface P3394DoctorReport { ok: boolean; checks: P3394DoctorCheck[] }

/**
 * V-01：运行中桥的 wiring 事实。app-wiring 把这些事实收集后交给
 * buildP3394WiringDoctorInput，Doctor 由此反映真实 listener/binding 状态
 * 而不是"未上报"。
 */
export interface P3394WiringDoctorFacts {
  manifest?: unknown;
  agentHomeExists: boolean;
  registryPersisted: boolean;
  runtimeAdapterBound: boolean;
  /** 入站信封的 extensions.epoch 会进入内核 replay protector。 */
  replayProtectionBound: boolean;
  idempotencyBound: boolean;
  auditJournalBound: boolean;
  policyBound: boolean;
  channelAdapterBound: boolean;
  objectStorePresent: boolean;
  channelCapabilitiesMissing: string[];
  resourceLimitsMissing: string[];
  autoReplyEnabled: boolean;
}

/** 把运行中桥的事实映射成完整 Doctor 输入（纯函数，便于测试）。 */
export function buildP3394WiringDoctorInput(facts: P3394WiringDoctorFacts): P3394DoctorInput {
  return {
    manifest: facts.manifest,
    agentHomeExists: facts.agentHomeExists,
    registryPersisted: facts.registryPersisted,
    runtimeAdapterBound: facts.runtimeAdapterBound,
    replayProtectionBound: facts.replayProtectionBound,
    idempotencyBound: facts.idempotencyBound,
    auditJournalBound: facts.auditJournalBound,
    policyBound: facts.policyBound,
    channelAdapterBound: facts.channelAdapterBound,
    objectStorePresent: facts.objectStorePresent,
    channelCapabilitiesMissing: facts.channelCapabilitiesMissing,
    resourceLimitsMissing: facts.resourceLimitsMissing,
    autoReplyEnabled: facts.autoReplyEnabled,
  };
}

export interface P3394DoctorInput {
  manifest?: unknown;
  /** True when the local peer registry has been persisted/loaded (Agent Home). */
  registryPersisted?: boolean;
  /** True when the Agent Home directory exists on disk. */
  agentHomeExists?: boolean;
  /** True when a real CogSeed runtime adapter is bound. */
  runtimeAdapterBound?: boolean;
  /** True when at least one channel adapter is registered. */
  channelAdapterBound?: boolean;
  /** True when the content-addressed object store is present. */
  objectStorePresent?: boolean;
  /** True when §11 result auto-reply is enabled. */
  autoReplyEnabled?: boolean;
  /** Missing required channel capabilities (empty array = all present). */
  channelCapabilitiesMissing?: string[];
  /** Whether replay protection and idempotency are wired into the bridge. */
  replayProtectionBound?: boolean;
  idempotencyBound?: boolean;
  /** Whether the audit journal and authorization policy are wired. */
  auditJournalBound?: boolean;
  policyBound?: boolean;
  /** Missing resource controls such as frame, queue, rate and concurrency limits. */
  resourceLimitsMissing?: string[];
}

export function runP3394BridgeDoctor(input: P3394DoctorInput = {}): P3394DoctorReport {
  const checks: P3394DoctorCheck[] = [];
  // §16-1 一行配置接入：manifest 校验通过即代表一行配置可接入桥。
  let manifest: P3394BridgeManifest | undefined;
  if (input.manifest === undefined) {
    checks.push({ name: 'manifest', status: 'warn', reason: 'no manifest provided', ref: '§16-1' });
  } else {
    const result = validateP3394BridgeManifest(input.manifest);
    if (result.ok === false) {
      checks.push({ name: 'manifest', status: 'fail', reason: result.error.reason, ref: '§16-1' });
    } else {
      manifest = result.manifest;
      checks.push({ name: 'manifest', status: 'pass', ref: '§16-1' });
      // §16-2 SSCLI 同机接入：local channel 声明（同机 gateway 语义）。
      checks.push({
        name: 'local-channel',
        status: manifest.channels.some((c) => c.kind === 'local') ? 'pass' : 'fail',
        ref: '§16-2',
      });
      // §16-4 @alias 解析 + 远端 Identity 验证：本节点身份是远端验证
      // expected_identity 的锚点（alias 解析由 registry 检查覆盖）。
      checks.push({ name: 'identity', status: manifest.identity.agent_id ? 'pass' : 'fail', ref: '§16-4' });
      // §16-15 doctor + 最小 Conformance Tests：声明的等级必须由真实
      // wiring 支撑（SDK §17: "magic" 必须可检视）。
      const level = manifest.conformance.level;
      const levelOk = level === 'bridge-phase-1' || (manifest.conformance.registry && manifest.conformance.agent_home && manifest.conformance.runtime_adapter);
      checks.push({
        name: 'conformance-level',
        status: levelOk ? 'pass' : 'fail',
        reason: levelOk ? 'declared ' + level : 'level ' + level + ' is not backed by registry/agent-home/runtime-adapter support',
        ref: '§16-15',
      });
      const caps = manifest.conformance.capabilities;
      if (caps) {
        checks.push({
          name: 'conformance-capabilities',
          status: 'pass',
          reason: ['sessions', 'artifacts', 'streaming', 'cancellation', 'restart_recovery', 'multi_party_sessions', 'delegation', 'checkpoints', 'resource_policy']
            .filter((key) => (caps as unknown as Record<string, boolean>)[key])
            .join(',') || 'no capabilities declared',
          ref: '§16-15',
        });
      }
    }
  }

  // §16-3 监听 + 主动连接：channel adapter 注册（listener/dialer 同一适配器面）。
  if (input.channelAdapterBound === undefined) {
    checks.push({ name: 'channel-adapter', status: 'warn', reason: 'channel adapter registration not reported', ref: '§16-3' });
  } else {
    checks.push({ name: 'channel-adapter', status: input.channelAdapterBound ? 'pass' : 'fail', reason: input.channelAdapterBound ? undefined : 'no channel adapter registered', ref: '§16-3' });
  }

  // §16-4 @alias 解析 + 远端 Identity 验证：peer registry 承载 alias →
  // agent_id 解析与 expected_identity 记录。
  if (input.registryPersisted === undefined) {
    checks.push({ name: 'registry', status: 'warn', reason: 'registry persistence not reported', ref: '§16-4' });
  } else {
    checks.push({ name: 'registry', status: input.registryPersisted ? 'pass' : 'fail', reason: input.registryPersisted ? undefined : 'peer registry is not persisted', ref: '§16-4' });
  }

  // §16-5 语义 Turn → 不可变信封：freezeEnvelope 是代码级保证，doctor
  // 输入里没有运行时证据 → 需运行时验证（§17 清单覆盖）。
  checks.push({ name: 'envelope-immutability', status: 'warn', reason: 'semantic turns are frozen into immutable envelopes at the code level (freezeEnvelope); needs runtime verification', ref: '§16-5' });

  // §16-6 多轮同 Session：会话由 executor/session-manager 承载，doctor
  // 输入里没有运行时证据 → 需运行时验证。
  checks.push({ name: 'session-continuity', status: 'warn', reason: 'multi-turn conversations share one P3394 session id; needs runtime verification', ref: '§16-6' });

  // §16-7 Goal 隔离：per-conversation session scope 是代码级保证 → 需运行时验证。
  checks.push({ name: 'goal-isolation', status: 'warn', reason: 'goals are isolated by per-conversation session scope; needs runtime verification', ref: '§16-7' });

  // §16-8 重启恢复：持久化 session 状态 + resumeForward 覆盖重启，但
  // doctor 输入里没有"重启后仍恢复"的运行时证据 → 需运行时验证。
  checks.push({
    name: 'restart-recovery',
    status: 'warn',
    reason: 'durable session state and resumeForward cover restart recovery'
      + (manifest?.conformance.capabilities?.restart_recovery ? ' (manifest declares restart_recovery)' : '')
      + '; needs runtime verification',
    ref: '§16-8',
  });

  // §16-9 Artifact URI + Digest：内容寻址对象存储。
  if (input.objectStorePresent === undefined) {
    checks.push({ name: 'object-store', status: 'warn', reason: 'object store presence not reported', ref: '§16-9' });
  } else {
    checks.push({ name: 'object-store', status: input.objectStorePresent ? 'pass' : 'fail', reason: input.objectStorePresent ? undefined : 'content-addressed object store missing', ref: '§16-9' });
  }

  // §16-10 AAR + KSTAR Episode：episode 落盘发生在任务终态（executor
  // recordEpisode 钩子），doctor 输入里没有运行时证据 → 需运行时验证。
  checks.push({ name: 'kstar-episodes', status: 'warn', reason: 'AAR and KSTAR episodes are recorded at task terminal states; needs runtime verification', ref: '§16-10' });

  // §16-11 四类 Agent 同一公共 API：真实 runtime adapter 绑定（agent /
  // sub_agent / task_agent / capability 走同一 RuntimeAdapter 面）。
  if (input.runtimeAdapterBound === undefined) {
    checks.push({ name: 'runtime-adapter', status: 'warn', reason: 'runtime adapter binding not reported', ref: '§16-11' });
  } else {
    checks.push({ name: 'runtime-adapter', status: input.runtimeAdapterBound ? 'pass' : 'fail', reason: input.runtimeAdapterBound ? undefined : 'no real CogSeed runtime adapter bound', ref: '§16-11' });
  }

  // §16-12 Registry 按 Alias 或 Capability 解析：registry 已持久化/加载时
  // alias 解析与 findByCapability 均可用；Agent Home 是其持久化目录。
  if (input.registryPersisted === undefined) {
    checks.push({ name: 'alias-capability-resolution', status: 'warn', reason: 'registry persistence not reported', ref: '§16-12' });
  } else {
    checks.push({
      name: 'alias-capability-resolution',
      status: input.registryPersisted ? 'pass' : 'fail',
      reason: input.registryPersisted ? 'peer registry available for alias and capability resolution' : 'peer registry is not persisted',
      ref: '§16-12',
    });
  }
  if (input.agentHomeExists === undefined) {
    checks.push({ name: 'agent-home', status: 'warn', reason: 'agent home not reported', ref: '§16-12' });
  } else {
    checks.push({ name: 'agent-home', status: input.agentHomeExists ? 'pass' : 'fail', reason: input.agentHomeExists ? undefined : 'agent home directory missing', ref: '§16-12' });
  }

  // §16-13 本地不足按 Policy 选远程：local-first 能力排序 + 授权策略是
  // 代码级保证，路由决策没有运行时证据 → 需运行时验证。
  checks.push({ name: 'remote-fallback', status: 'warn', reason: 'local-first capability resolution falls back to remote peers per policy; needs runtime verification', ref: '§16-13' });

  // §16-14 Reduced Profile：capability/model_runtime 白名单（非自主节点
  // 不得声明 autonomous-agent）是代码级保证 → 需运行时验证。
  checks.push({ name: 'reduced-profile', status: 'warn', reason: 'capability/model_runtime nodes are whitelisted non-autonomous profiles; needs runtime verification', ref: '§16-14' });

  // §17.3 channel 能力闸门：信道的必备语义（cancellation / identity_proof 等）。
  if (input.channelCapabilitiesMissing === undefined) {
    checks.push({ name: 'channel-capabilities', status: 'warn', reason: 'required channel capability check not reported', ref: '§17.3' });
  } else if (Array.isArray(input.channelCapabilitiesMissing) && input.channelCapabilitiesMissing.length > 0) {
    checks.push({ name: 'channel-capabilities', status: 'fail', reason: 'channel cannot carry required semantics: ' + input.channelCapabilitiesMissing.join(', '), ref: '§17.3' });
  } else {
    checks.push({ name: 'channel-capabilities', status: 'pass', ref: '§17.3' });
  }

  // §11 结果自动回发状态。
  if (input.autoReplyEnabled === undefined) {
    checks.push({ name: 'auto-reply', status: 'warn', reason: '§11 auto reply state not reported', ref: '§11' });
  } else {
    checks.push({ name: 'auto-reply', status: input.autoReplyEnabled ? 'pass' : 'warn', reason: input.autoReplyEnabled ? '§11 result auto reply-back enabled' : '§11 result auto reply-back disabled', ref: '§11' });
  }

  // §17.3 认证与 Replay / 审计。
  const booleanBindings: Array<[string, boolean | undefined, string, string]> = [
    ['replay-protection', input.replayProtectionBound, 'replay protection binding not reported', '§17.3'],
    ['idempotency', input.idempotencyBound, 'idempotency binding not reported', '§17.3'],
    ['audit-journal', input.auditJournalBound, 'audit journal binding not reported', '§17.3'],
    ['policy', input.policyBound, 'authorization policy binding not reported', '§16-13'],
  ];
  for (const [name, value, missingReason, ref] of booleanBindings) {
    checks.push({ name, status: value === undefined ? 'warn' : value ? 'pass' : 'fail', ...(value === undefined ? { reason: missingReason } : value ? {} : { reason: name + ' is not bound' }), ref });
  }
  if (input.resourceLimitsMissing === undefined) {
    checks.push({ name: 'resource-limits', status: 'warn', reason: 'resource limit checks not reported', ref: '§17.3' });
  } else if (input.resourceLimitsMissing.length > 0) {
    checks.push({ name: 'resource-limits', status: 'fail', reason: 'missing resource limits: ' + input.resourceLimitsMissing.join(', '), ref: '§17.3' });
  } else {
    checks.push({ name: 'resource-limits', status: 'pass', ref: '§17.3' });
  }

  return { ok: checks.every((c) => c.status !== 'fail'), checks };
}
