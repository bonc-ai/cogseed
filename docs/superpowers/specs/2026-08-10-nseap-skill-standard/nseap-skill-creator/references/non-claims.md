# Non-claims — the hard boundaries (and why they exist)

These are not style preferences. They are the discipline that makes an NSEAP SkillPackage
*honest*. A scaffold that violates them is worse than no scaffold, because it invites
someone to trust something that hasn't earned trust.

## The hard list (put an explicit non-claims block in every skill)

1. **`staged` is the highest state.** Every artifact carries `promotion_ceiling: staged`
   and `production_release_allowed: false`. This skill emits **staged scaffolds only** —
   it never publishes, deploys, or releases.
2. **DeltaR is a learning signal, not a release instruction.** A positive ΔR means the
   skill *could* improve; it never authorizes a production push.
3. **`staged` / `release_ready` ≠ production release.** Passing a registry gate means
   "materials complete + governance logged to staged" — **not** "ready for production" and
   **not** "loadable by a production Agent runtime."
4. **The skill exposes contract field-positions, but does not implement mechanisms.**
   `owner_context`, resource/permission/owner_binding/audit contracts are **field-positions
   we expose**; their real values (identity resolution, resource access, tokens) are
   injected at load time by the Agent / Gateway layer (`binding_resolved_by: agent_layer`).
   The skill must never resolve identity, touch a real resource, or hold a token.
5. **Symbolic decides right/wrong; neural decides good/bad.** The LLM only proposes DRAFT
   wording/candidates. It must never write `formal`, `config_key`, or `value`, and never
   judge well-formedness — that is the symbolic layer's job.

## What this skill deliberately does NOT do (say so plainly)

- It does **not** run the real KSTAR causal-learning loop (ΔR/ΔA, reflect→distill→gates).
  That needs the Python `metaskill` engine. A scaffold has *hooks* for KSTAR, not a *run*.
- It does **not** reach Tier C (1.0 release). That is governance/release owners' work.
- It does **not** produce a production-deployable object. "Compiled to staged" (a packaging
  snapshot) is possible in the engine; **production loading/deployment is not** — that is an
  upstream (E0) vision, out of this repo's scope.

## The honesty test

Before handing a scaffold to the user, ask: *"Does anything here imply this skill has
learned, been validated in production, or is deployable?"* If yes, fix the wording. Label
unfinished parts **"target-state / author-fills / needs engine"** — never "done" or
"production-ready".
