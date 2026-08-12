# Governance boundaries — invoice_dunning (non-claims)

- `promotion_ceiling: staged`; `production_release_allowed: false`. Every artifact is staged.
- The skill **decides and drafts**; it does **not** send messages, charge cards, or write to
  the billing system. Those are downstream actions performed by owner-authorized systems.
- Resource/identity values (owner_id, real authorization scope, billing access) are
  **injected by the Agent/Gateway layer** (`binding_resolved_by: agent_layer`). The skill
  holds no tokens and makes no direct resource calls.
- **Symbolic decides right/wrong** (which rule fires, whether the route is valid);
  **neural decides good/bad** (only drafts the message wording). The LLM never writes
  `formal` / `config_key` / `value`, and never judges well-formedness.
- Not claimed: production-ready, deployed, learned-in-production, or loadable by a
  production runtime. This is a staged, standard-compliant scaffold.
