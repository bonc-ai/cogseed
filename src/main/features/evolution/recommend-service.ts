import { listOntologyBindings } from './ontology-bindings';

// 进化推荐:从技能绑定的领域本体 rbox 规则 + 高ΔR episode + 个人本体 tbox 偏好生成建议。
// 依赖注入便于测试;生产用真实 bindings/本体读取/episode 源。
const DELTA_R_THRESHOLD = 0.5;

interface OntologyLite {
  category: string;
  name: string;
  rbox: Array<{ id?: string; name?: string; description?: string; severity?: string }>;
  tbox: Array<{ label?: string; key?: string; description?: string; value?: string }>;
}
interface EpisodeLite { id: string; task?: string; delta_r: number; }

export interface RecommendSuggestion {
  id: string;
  source?: string;      // 'episode' 时为交互记录来源
  ontology: string;
  rule: string;
  description: string;
  severity: string;
  suggestion: string;
  selected: boolean;
}

interface RecommendDeps {
  listBindings?: (uid: string, skillId: string) => Promise<string[]>;
  loadOntology: (id: string) => Promise<OntologyLite | null>;
  listEpisodes: (uid: string, skillId: string) => Promise<EpisodeLite[]>;
}

// 生产入口:注入真实 deps(本体经引擎 Reader over 技能本体目录;episode 经 p3394 projections)。
// 任一依赖失败降级为空贡献,不外抛(推荐是辅助信息,不能挡住页面)。
export async function recommendForSkill(
  uid: string, skillId: string,
): Promise<{ skillId: string; suggestions: RecommendSuggestion[] }> {
  const { loadEngine } = await import('./engine-loader');
  const { listKstarCompatProjections } = await import('../p3394');
  const path = await import('node:path');

  const skillOntoDir = path.join(
    process.env.ORKAS_WORKSPACE_ROOT || '', uid, 'cloud', 'skills', skillId, 'ontology',
  );

  const loadOntology = async (id: string): Promise<OntologyLite | null> => {
    try {
      const engine = await loadEngine();
      const Reader = engine.OntologyReader as new (dir: string) => {
        loadOntology: (oid: string) => Promise<{ slice: { tbox: unknown[]; rbox: unknown[] }; manifest: { title?: string } }>;
      };
      const reader = new Reader(skillOntoDir);
      const { slice, manifest } = await reader.loadOntology(id);
      // category 从 id 前缀猜(domain-*/personal-*),否则按有无 rbox 归为 domain。
      const category = id.startsWith('personal') ? 'personal' : 'domain';
      return {
        category, name: manifest.title || id,
        rbox: (slice.rbox as OntologyLite['rbox']) || [],
        tbox: (slice.tbox as OntologyLite['tbox']) || [],
      };
    } catch { return null; }
  };

  const listEpisodes = async (u: string, sk: string): Promise<EpisodeLite[]> => {
    try {
      const runs = await listKstarCompatProjections(u);
      return runs
        .filter((r) => r && (r as { kstar_episode?: unknown }).kstar_episode)
        .map((r) => {
          const ep = (r as { kstar_episode: { episode_id: string; task?: string; delta_r?: number } }).kstar_episode;
          return { id: ep.episode_id, task: ep.task, delta_r: Number(ep.delta_r || 0) };
        });
    } catch { return []; }
  };

  return buildRecommendations(uid, skillId, { loadOntology, listEpisodes });
}

export async function buildRecommendations(
  uid: string, skillId: string, deps: RecommendDeps,
): Promise<{ skillId: string; suggestions: RecommendSuggestion[] }> {
  const getBindings = deps.listBindings ?? ((u, s) => listOntologyBindings(u, s));
  const boundIds = await getBindings(uid, skillId);

  const suggestions: RecommendSuggestion[] = [];

  const domain: OntologyLite[] = [];
  const personal: OntologyLite[] = [];
  for (const id of boundIds) {
    const o = await deps.loadOntology(id);
    if (!o) continue;
    if (o.category === 'domain') domain.push(o);
    else if (o.category === 'personal') personal.push(o);
  }

  for (const onto of domain) {
    for (const r of (onto.rbox || []).slice(0, 5)) {
      suggestions.push({
        id: `sug_${onto.name}_${r.id ?? r.name ?? ''}`,
        ontology: onto.name,
        rule: r.name ?? r.id ?? '',
        description: r.description ?? '',
        severity: r.severity ?? 'info',
        suggestion: `在 SKILL.md 中加入规则: ${r.description ?? ''}`,
        selected: false,
      });
    }
  }

  const episodes = await deps.listEpisodes(uid, skillId);
  for (const ep of episodes) {
    if (Math.abs(ep.delta_r) < DELTA_R_THRESHOLD) continue;
    suggestions.push({
      id: `sug_ep_${ep.id}`,
      source: 'episode',
      ontology: '交互记录',
      rule: `Episode (ΔR=${ep.delta_r})`,
      description: (ep.task ?? '').slice(0, 100) || '交互问题',
      severity: Math.abs(ep.delta_r) > 0.5 ? 'warning' : 'info',
      suggestion: `用户反馈: ${(ep.task ?? '').slice(0, 80)}。建议改进 Skill 以解决此问题`,
      selected: false,
    });
  }

  for (const onto of personal) {
    for (const f of (onto.tbox || []).slice(0, 3)) {
      const label = f.label ?? f.key ?? '';
      const desc = f.description ?? f.value ?? '';
      suggestions.push({
        id: `sug_${onto.name}_${label}`,
        ontology: onto.name,
        rule: label,
        description: desc,
        severity: 'info',
        suggestion: `根据用户偏好(${label}): ${desc}`,
        selected: false,
      });
    }
  }

  return { skillId, suggestions: suggestions.slice(0, 10) };
}
