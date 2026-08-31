# Audit Rules

The scanner is intentionally conservative about material that can disclose a credential, a person, a private environment, or an unfinished release artifact. Findings are relative to the selected scan scope and are always redacted before they are printed.

## Blocking rules

| Rule ID | Meaning |
| --- | --- |
| `SECRET_PRIVATE_KEY` | PEM/OpenSSH/PGP private-key material or a private-key file. |
| `SECRET_TOKEN` | High-confidence bearer, GitHub, AWS, OpenAI/Anthropic, or comparable access token. |
| `SECRET_ASSIGNMENT` | A non-placeholder password, API key, client secret, or access-token assignment. |
| `FILE_AUTH_CONFIG` | `.env`, credentials, auth, cookie, token, or private-key file that is in scope. Example templates are downgraded. |
| `PRIVACY_USER_PATH` | A real absolute home path containing a non-example local user name. |
| `PRIVACY_CONTACT` | A high-confidence personal email or phone number outside an obvious fixture/example. |
| `PRIVACY_INTERNAL_NET` | A non-local RFC1918 address, internal GitLab/service URL, or production-only host. |
| `FILE_INTERNAL_MATERIAL` | An internal/private/confidential/pre-release/release-checklist/draft artifact that is not clearly public documentation. |
| `FILE_LOG_DUMP` | Logs, database dumps, crash dumps, credential stores, or local session exports. |
| `LICENSE_MIT_MISSING` | Root `LICENSE` is missing or does not identify the MIT License. |
| `LICENSE_THIRD_PARTY_MISSING` | Third-party notices, license directory, or required REUSE/SBOM material is missing or structurally invalid. |
| `SCAN_UNKNOWN` | Git/file enumeration or decoding failed, so cleanliness cannot be established. |

## Warning rules

| Rule ID | Meaning |
| --- | --- |
| `PRIVACY_INTERNAL_SUSPECTED` | An internal-looking hostname/address or contact could not be confirmed as sensitive. |
| `SECRET_EXAMPLE` | A credential-shaped example remains after allowlist checks; replace it or document why it is safe. |
| `FILE_LARGE` | A file is larger than the configured threshold and may be a build artifact, model, cache, or private resource. |
| `FILE_BINARY` | A binary or media file is in scope; verify that it is intended for public distribution. |
| `FILE_GENERATED` | A generated/cache/build file is in scope. |
| `LICENSE_METADATA_INCOMPLETE` | A third-party entry lacks a version, source, or license detail but does not make the complete project unpublishable by itself. |
| `PROJECT_CHECKS_SKIPPED` | Repository-local checks were not executed because arbitrary repository code is disabled by default. |
| `VULNERABILITY_SCAN_UNCOVERED` | No network vulnerability database was consulted. This is a coverage note, never a pass claim. |

## Known allowed samples

The following are ignored for blocking rules when they occur as clear test/documentation placeholders. The scanner still records a low-severity note when useful:

- `synthetic-secret`, `synthetic-token`, `test-token`, `dummy-token`, `fake-secret`, `example`, `placeholder`, `changeme`;
- scanner-generated redaction markers such as `[token sha256:...]` and `[secret sha256:...]`;
- `${ENV_VAR}`, `$API_KEY`, `process.env.*`, `os.environ[...]`, and similar runtime references;
- `localhost`, `127.0.0.1`, `::1`, `.test` documentation domains, and RFC 5737 documentation ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`);
- fixture identities such as `alice@example.com`, `/Users/test`, `/Users/tester`, `/home/test`, and phone numbers explicitly labelled as test data;
- public license/contact metadata when it is clearly part of `NOTICE`, `CODE_OF_CONDUCT`, `publiccode.yml`, or `.reuse/dep5`.

An allowlisted match must not be used to hide a real value on the same line. Review context and use a scoped exemption when needed.

Test, demo, fixture, and sample directory names alone are not exemptions. A realistic provider token, private key, or credential assignment remains blocking even inside a test; only the matched value itself can be an allowed placeholder, or the user can supply a narrow `--allow RULE_ID:path` exemption. Comments, variable names, and directory names cannot hide a real value. Privacy examples may use an explicit inline test/documentation marker, but a path name alone is never enough.

## Explicit exemptions

Pass `--allow RULE_ID` or `--allow RULE_ID:path/to/file` for a reviewed, intentional exception. The match is suppressed only for that run; rerun without `--allow` to print it. Exemptions should be narrow; never use a blanket `--allow` to make an unknown scan error pass.

## Interpreting results

- Any blocking finding or an unknown scan failure produces `BLOCKED` and exit code `1`.
- Warnings only produce `PASS_WITH_WARNINGS` and exit code `0`.
- No findings produce `PASS` and exit code `0`.
- The scanner does not determine copyright ownership or grant MIT rights. Confirm that all contributors and bundled third-party notices are handled separately.
