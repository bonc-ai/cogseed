import { createHash } from "node:crypto";
import type { Message } from "../shared/types.js";
import { esticogseedTextTokens } from "./session.js";

const MAX_SNAPSHOTS = 16;
export const MAX_RETAINED_EXECUTION_CONTEXT_TOKENS = 2_048;
const SNAPSHOT_HEADER = "[Host execution state snapshot — not a user request]\n"
  + "The latest snapshot supersedes all earlier execution-state snapshots. "
  + "It does not change the user's goal or authorize additional actions.\n\n";

type Snapshot = { at: number; message: Message; tokens: number };

/** One run's transport-only state. Keep the canonical transcript in model
 * order and insert changed host state after its already-sent prefix. Retain
 * only bounded text snapshots and message digests, never a second transcript.
 * Compaction, healing, image offloading or any other canonical rewrite resets
 * this projection. Request-scoped loop controls are intentionally excluded. */
export class RequestContextProjection {
  private fingerprints: string[] = [];
  private snapshots: Snapshot[] = [];
  private currentState = "";
  private retainedTokens = 0;
  private disabled = false;

  /** Extra tokens beyond the canonical current-state view. Include these in
   * tool-result headroom; project() also sheds them near the window limit. */
  get overheadTokens(): number { return this.retainedTokens; }

  /** One-way per run: canonical context remains available if an actual
   * provider limit rejects the optional projection despite estimation. */
  disable(): void {
    this.reset();
    this.disabled = true;
  }

  project(base: Message[], state: Message[], maxMessageTokens: number): Message[] {
    if (this.disabled) return [...base, ...state];
    const fingerprints = base.map((message) => createHash("sha256").update(JSON.stringify(message)).digest("hex"));
    const appendOnly = this.fingerprints.length <= fingerprints.length
      && this.fingerprints.every((hash, index) => hash === fingerprints[index]);
    if (!appendOnly) this.reset();

    const currentState = JSON.stringify(state);
    const text = state.flatMap((message) => message.content.flatMap((content) =>
      content.type === "text" ? [content.text] : [])).join("\n\n");
    // A clearing snapshot is necessary when a previously exposed plan/ledger
    // disappears; otherwise its old instructions would remain authoritative.
    if (currentState !== this.currentState && (text || this.snapshots.length)) {
      const message: Message = { role: "user", content: [{ type: "text", text: SNAPSHOT_HEADER
        + (text || "No current execution plan or work ledger. Earlier snapshots are superseded.") }] };
      this.snapshots.push({ at: base.length, message, tokens: messageTokens([message]) });
    }
    this.currentState = currentState;
    this.fingerprints = fingerprints;
    const canonicalTokens = messageTokens(base) + messageTokens(state);
    const snapshotTokens = this.snapshots.reduce((sum, snapshot) => sum + snapshot.tokens, 0);
    this.retainedTokens = Math.max(0, snapshotTokens - messageTokens(state));
    if (this.snapshots.length > MAX_SNAPSHOTS
      || this.retainedTokens > MAX_RETAINED_EXECUTION_CONTEXT_TOKENS
      || canonicalTokens + this.retainedTokens > maxMessageTokens) {
      // Use the exact canonical view when over budget. Do not keep an
      // oversized "latest" snapshot outside the bound or drop current state.
      this.reset();
      return [...base, ...state];
    }

    const result: Message[] = [];
    let from = 0;
    for (const snapshot of this.snapshots) {
      result.push(...base.slice(from, snapshot.at), snapshot.message);
      from = snapshot.at;
    }
    result.push(...base.slice(from));
    return result;
  }

  private reset(): void {
    this.fingerprints = [];
    this.snapshots = [];
    this.currentState = "";
    this.retainedTokens = 0;
  }
}

// Structured estimate includes role/field overhead and CJK text. Unlike raw
// session accounting it also conservatively counts opaque/binary content.
function messageTokens(messages: Message[]): number {
  return esticogseedTextTokens(JSON.stringify(messages));
}
