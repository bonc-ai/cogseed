# Mandatory Web Research and Source-Verification Gate · v0.1 Candidate

## Purpose

A complete domain volume contains current policy and standard facts. These facts must not be supplied from model memory or search snippets. The executing Agent must search, open, read, and record authoritative sources before the deterministic report pipeline runs.

## Responsibility split

| Component | Responsibility |
|---|---|
| Executing Agent | Search the web, open primary sources, inspect relevant PDF pages, record queries, claims, versions, conflicts and source fingerprints |
| `validate_research_bundle.py` | Validate schemas, cross-references, primary-source rules, report-source bindings, standard versions, research-question resolution and conflict status |
| `run_skill.py` | Block Word generation until the computed research gate passes; inject the gate summary into report data |
| Human reviewer | Review source interpretation, professional boundaries and final report; visual-check every rendered page |

## Non-negotiable rules

1. Search-result snippets are discovery aids, not evidence.
2. Every selected source must be opened and read.
3. Current/future facts and critical claims require verified primary sources.
4. Secondary sources cannot be the sole support for a critical claim.
5. Policy scope must be bound to an issuing-authority source.
6. Every report standard row must have an explicit official source and researched version/date binding.
7. Policy-date, policy-scope and standard-version conflicts must be resolved.
8. The computed gate—not a manually edited field—controls progression.
9. A passed gate is not external certification, professional approval or production readiness.

## Gate artifacts

```text
research-plan.json
web-research-ledger.json
research-gate.json                 # computed
research-validation-report.json    # computed
```

## Blocking conditions

- missing or invalid research plan/ledger;
- no official policy source;
- insufficient official standards/specification sources;
- selected source not opened/read;
- current fact without verified primary source;
- critical research question unresolved;
- report source ID missing from the ledger;
- report standard unverified or version mismatch;
- unresolved date, scope or version conflict;
- domain/research-date mismatch among plan, ledger and report.
