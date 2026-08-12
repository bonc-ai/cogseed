# Source and Citation Rules · v0.1 Candidate

## Source IDs

- `P`: policy/government/issuing-authority source;
- `S`: official standard, specification or international organization;
- `I`: user-provided internal material;
- `E`: explicit expert decision;
- `A`: analyst synthesis/recommendation;
- `R`: secondary discovery reference.

## Mandatory web evidence rules

1. Policy scope, current status, standard version and other current external facts require opened primary sources.
2. Search-result snippets do not count as evidence.
3. `R` sources may identify leads but must not be the sole support for a critical claim.
4. Every P/S/R source used in the report appendix must resolve to a ledger record.
5. Every standard row must have an exact-name version-verification record and official source binding.
6. Record issuer, URL, access time, version/date, relevant section and SHA-256 fingerprint.
7. Record and resolve conflicts; do not silently choose a convenient date or version.
8. Preserve internal terminology and explicitly record adopted treatment when internal material differs from formal policy or standards.
9. Paraphrase by default. Human-readable URLs/file references belong in Appendix B.
10. Never leak tool citation tokens or raw retrieval IDs into Word.
