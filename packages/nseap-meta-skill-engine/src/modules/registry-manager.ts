// ============================================================
// Module: Registry Manager
// Manages skill library + ontology library versioning
// Implements: append-only audit ledger, staging, rollback support
// ============================================================

import type { RegistryEntry, SkillRef, OntologyManifest } from '../types/index.js';
import { generateId, generateHash } from '../utils/ids.js';

/**
 * Registry Manager — versioned storage for skills, ontologies, and evidence
 * Key principle: every artifact has stable ID + version + hash + ref
 */
export class RegistryManager {
  private entries: RegistryEntry[] = [];
  private auditLog: Array<{ action: string; artifact_id: string; timestamp: string; details: string }> = [];

  /**
   * Register a new skill in the registry
   */
  registerSkill(skill: SkillRef, content: string): RegistryEntry {
    const entry: RegistryEntry = {
      artifact_id: skill.skill_id,
      artifact_type: 'skill',
      version: skill.skill_version,
      status: 'draft',
      path: skill.skill_path,
      hash: generateHash(content),
      updated_at: new Date().toISOString(),
    };
    this.entries.push(entry);
    this.audit('REGISTER', entry.artifact_id, `Registered skill: ${skill.skill_name} v${skill.skill_version}`);
    return entry;
  }

  /**
   * Register a new ontology
   */
  registerOntology(manifest: OntologyManifest, content: string): RegistryEntry {
    const entry: RegistryEntry = {
      artifact_id: manifest.id,
      artifact_type: 'ontology',
      version: manifest.version,
      status: 'draft',
      path: manifest.file_path,
      hash: generateHash(content),
      updated_at: new Date().toISOString(),
    };
    this.entries.push(entry);
    this.audit('REGISTER', entry.artifact_id, `Registered ontology: ${manifest.title} v${manifest.version}`);
    return entry;
  }

  /**
   * Promote an artifact to a new version
   */
  promote(artifactId: string, newVersion: string, newContent: string): RegistryEntry {
    const existing = this.entries.find(e => e.artifact_id === artifactId);
    if (!existing) throw new Error(`Artifact not found: ${artifactId}`);

    const entry: RegistryEntry = {
      ...existing,
      version: newVersion,
      hash: generateHash(newContent),
      updated_at: new Date().toISOString(),
    };
    this.entries.push(entry);
    this.audit('PROMOTE', artifactId, `Promoted: v${existing.version} → v${newVersion}`);
    return entry;
  }

  /**
   * Update status (draft → staged → production → rejected)
   */
  updateStatus(artifactId: string, newStatus: string): void {
    const entry = this.entries.find(e => e.artifact_id === artifactId);
    if (!entry) throw new Error(`Artifact not found: ${artifactId}`);
    const oldStatus = entry.status;
    entry.status = newStatus;
    entry.updated_at = new Date().toISOString();
    this.audit('STATUS_CHANGE', artifactId, `${oldStatus} → ${newStatus}`);
  }

  /**
   * Get artifact by ID (latest version)
   */
  getLatest(artifactId: string): RegistryEntry | undefined {
    const matches = this.entries.filter(e => e.artifact_id === artifactId);
    return matches.sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  }

  /**
   * Get full version history
   */
  getHistory(artifactId: string): RegistryEntry[] {
    return this.entries
      .filter(e => e.artifact_id === artifactId)
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  }

  /**
   * List all artifacts (latest version only)
   */
  listAll(): RegistryEntry[] {
    const latestMap = new Map<string, RegistryEntry>();
    for (const entry of this.entries) {
      const existing = latestMap.get(entry.artifact_id);
      if (!existing || entry.updated_at > existing.updated_at) {
        latestMap.set(entry.artifact_id, entry);
      }
    }
    return Array.from(latestMap.values());
  }

  /**
   * Get audit log (append-only)
   */
  getAuditLog(): Array<{ action: string; artifact_id: string; timestamp: string; details: string }> {
    return [...this.auditLog];
  }

  // ── Private ─────────────────────────────────────────────

  private audit(action: string, artifactId: string, details: string): void {
    this.auditLog.push({
      action,
      artifact_id: artifactId,
      timestamp: new Date().toISOString(),
      details,
    });
  }
}
