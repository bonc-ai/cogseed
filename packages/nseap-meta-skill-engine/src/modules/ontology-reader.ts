// ============================================================
// Module: Ontology Reader (Team D interface)
// Reads TBox/RBox/ABox YAML files and serves ontology slices
// ============================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'yaml';
import { fileURLToPath } from 'url';
import type {
  OntologyClass,
  OntologyRule,
  OntologyExample,
  OntologyIndividual,
  OntologySlice,
  OntologyManifest,
} from '../types/index.js';

// ── Package-local ontology resolution ───────────────────────

/**
 * Resolve ontology path relative to package root
 * Contract: Package-local ontologies are in packages/nseap-meta-skill-engine/ontologies/
 */
export function resolveOntologyPath(ontologyName: string): string {
  // Get current file path in ESM
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  // Navigate from src/modules/ to package root
  const packageRoot = path.resolve(__dirname, '..', '..');
  const ontologiesDir = path.join(packageRoot, 'ontologies');

  return path.join(ontologiesDir, ontologyName);
}

/**
 * List all package-local ontologies
 */
export function listPackageOntologies(): string[] {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const packageRoot = path.resolve(__dirname, '..', '..');
  const ontologiesDir = path.join(packageRoot, 'ontologies');

  try {
    const entries = fs.readdir(ontologiesDir, { withFileTypes: true });
    return [];
  } catch {
    return [];
  }
}

/**
 * Ontology Reader — loads and caches ontology YAML files
 * Mirrors the OntoMem's role of serving ontology slices to agents
 */
export class OntologyReader {
  private cache = new Map<string, { manifest: OntologyManifest; slice: OntologySlice; loaded_at: string }>();
  private ontologyDir: string;

  constructor(ontologyDir: string) {
    this.ontologyDir = ontologyDir;
  }

  /**
   * Load a complete ontology package (tbox + rbox + abox)
   */
  async loadOntology(ontologyId: string, version?: string): Promise<{ manifest: OntologyManifest; slice: OntologySlice }> {
    const cacheKey = `${ontologyId}@${version ?? 'latest'}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return { manifest: cached.manifest, slice: cached.slice };

    // Resolve ontology directory
    const ontologyPath = path.join(this.ontologyDir, ontologyId);
    const stats = await fs.stat(ontologyPath).catch(() => null);
    if (!stats || !stats.isDirectory()) {
      throw new Error(`Ontology not found: ${ontologyId} at ${ontologyPath}`);
    }

    // Load TBox
    const tbox = await this.loadTBox(ontologyPath);
    // Load RBox
    const rbox = await this.loadRBox(ontologyPath);
    // Load ABox
    const abox = await this.loadABox(ontologyPath);
    // Load Individuals
    const individuals = await this.loadIndividuals(ontologyPath);

    const slice: OntologySlice = { tbox, rbox, abox, individuals };
    const manifest: OntologyManifest = {
      id: ontologyId,
      iri: `urn:nseap:ontology:${ontologyId}`,
      version: version ?? '0.1.0',
      title: ontologyId,
      description: `Ontology package: ${ontologyId}`,
      file_path: ontologyPath,
    };

    this.cache.set(cacheKey, { manifest, slice, loaded_at: new Date().toISOString() });
    return { manifest, slice };
  }

  /**
   * Extract a scoped slice — only the classes, rules, examples the skill actually needs
   */
  extractSlice(fullSlice: OntologySlice, options: {
    classIds?: string[];
    ruleIds?: string[];
    exampleTypes?: Array<'positive_fewshot' | 'negative_fewshot' | 'reasoning_drill' | 'clarification_example'>;
  }): OntologySlice {
    return {
      tbox: options.classIds
        ? fullSlice.tbox.filter(c => options.classIds!.includes(c.id))
        : fullSlice.tbox,
      rbox: options.ruleIds
        ? fullSlice.rbox.filter(r => options.ruleIds!.includes(r.id))
        : fullSlice.rbox,
      abox: options.exampleTypes
        ? fullSlice.abox.filter(e => options.exampleTypes!.includes(e.type))
        : fullSlice.abox,
    };
  }

  /**
   * List all available ontologies
   */
  async listOntologies(): Promise<OntologyManifest[]> {
    const entries = await fs.readdir(this.ontologyDir, { withFileTypes: true });
    const ontologies: OntologyManifest[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        ontologies.push({
          id: entry.name,
          iri: `urn:nseap:ontology:${entry.name}`,
          version: '0.1.0',
          title: entry.name,
          description: `Ontology package: ${entry.name}`,
          file_path: path.join(this.ontologyDir, entry.name),
        });
      }
    }
    return ontologies;
  }

  /**
   * Invalidate cache for a specific ontology
   */
  invalidate(ontologyId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(ontologyId)) this.cache.delete(key);
    }
  }

  // ── Private loaders ─────────────────────────────────────

  private async loadTBox(ontologyPath: string): Promise<OntologyClass[]> {
    const files = await fs.readdir(ontologyPath);
    const tboxFile = files.find(f => f.includes('tbox') || f.includes('tbox.yaml'));
    if (!tboxFile) return [];

    const content = await fs.readFile(path.join(ontologyPath, tboxFile), 'utf-8');
    const parsed = yaml.parse(content);
    return this.normalizeTBox(parsed);
  }

  private async loadRBox(ontologyPath: string): Promise<OntologyRule[]> {
    const files = await fs.readdir(ontologyPath);
    const rboxFile = files.find(f => f.includes('rbox') || f.includes('rbox.yaml'));
    if (!rboxFile) return [];

    const content = await fs.readFile(path.join(ontologyPath, rboxFile), 'utf-8');
    const parsed = yaml.parse(content);
    return this.normalizeRBox(parsed);
  }

  private async loadABox(ontologyPath: string): Promise<OntologyExample[]> {
    const files = await fs.readdir(ontologyPath);
    const aboxFile = files.find(f => f.includes('abox') || f.includes('abox.yaml'));
    if (!aboxFile) return [];

    const content = await fs.readFile(path.join(ontologyPath, aboxFile), 'utf-8');
    const parsed = yaml.parse(content);
    return this.normalizeABox(parsed);
  }

  private async loadIndividuals(ontologyPath: string): Promise<OntologyIndividual[]> {
    const files = await fs.readdir(ontologyPath);
    const aboxFile = files.find(f => f.includes('abox') || f.includes('abox.yaml'));
    if (!aboxFile) return [];

    const content = await fs.readFile(path.join(ontologyPath, aboxFile), 'utf-8');
    const parsed = yaml.parse(content);
    return this.normalizeIndividuals(parsed);
  }

  // ── Normalizers (handle various YAML shapes) ─────────────

  private normalizeTBox(parsed: any): OntologyClass[] {
    if (!parsed) return [];
    // Handle scene_tbox.yaml format
    if (parsed.classes) {
      return parsed.classes.map((c: any) => ({
        id: c.id,
        label: c.label ?? c.id,
        description: c.description ?? '',
        alternative_labels: c.alternative_labels,
        class_kind: c.class_kind ?? 'entity',
        grain: c.grain ?? 'instance',
        identifier_properties: c.identifier_properties,
        parent: c.parent,
        query_entry: c.agent?.query_entry ?? c['agent.query_entry'] ?? false,
        annotations: c.annotations,
      }));
    }
    // Handle direct array
    if (Array.isArray(parsed)) {
      return parsed.map((c: any) => ({
        id: c.id,
        label: c.label ?? c.id,
        description: c.description ?? '',
        class_kind: c.class_kind ?? 'entity',
        grain: c.grain ?? 'instance',
        parent: c.parent,
        query_entry: c.agent?.query_entry ?? false,
      }));
    }
    return [];
  }

  private normalizeRBox(parsed: any): OntologyRule[] {
    if (!parsed) return [];
    const rules = parsed.rbox?.rules ?? parsed.rules ?? [];
    return rules.map((r: any) => ({
      id: r.id,
      type: r.type ?? 'validation',
      name: r.name ?? r.id,
      description: r.description ?? '',
      applies_to: r.applies_to ?? { classes: [] },
      condition: {
        when: r.condition?.when ?? '',
        user_expressions: r.condition?.user_expressions,
        user_exceptions: r.condition?.user_exceptions,
      },
      action: r.action ?? { type: 'block', instruction: '' },
      severity: r.severity ?? 'warning',
      evidence: r.evidence,
      confidence: r.confidence ?? 0.8,
      review_required: r.review_required,
    }));
  }

  private normalizeABox(parsed: any): OntologyExample[] {
    if (!parsed) return [];
    const examples = parsed.abox?.case_examples ?? parsed.case_examples ?? (Array.isArray(parsed) ? parsed : []);
    return examples.map((e: any) => ({
      id: e.id,
      name: e.name,
      type: e.type ?? 'positive_fewshot',
      user_query: e.user_query ?? '',
      expected_understanding: e.expected_understanding ?? '',
      expected_query_plan: e.expected_query_plan,
      expected_behavior: e.expected_behavior ?? { status: '', explanation: '' },
      evidence: e.evidence,
      confidence: e.confidence,
    }));
  }

  private normalizeIndividuals(parsed: any): OntologyIndividual[] {
    if (!parsed?.abox?.instance_facts?.individuals) return [];
    return parsed.abox.instance_facts.individuals.map((i: any) => ({
      individual_id: i.individual_id,
      class: i.class,
      assertions: i.assertions ?? [],
    }));
  }
}
