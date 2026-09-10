# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| latest release | ✅ |

Security fixes are applied to the latest stable release. Older versions are
supported on a best-effort basis.

## Reporting a Vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report vulnerabilities privately through one of the following channels:

1. **Preferred: GitHub private vulnerability reporting** — use the
   **Security → Report a vulnerability** button on the repository page
   (https://github.com/bonc-ai/cogseed/security).
2. **Alternative: email** — **business@bonc.com.cn**

Please include:

- The affected version and platform.
- A description of the vulnerability.
- Steps to reproduce, or a proof of concept.
- Impact assessment, if known.

## Response Timeline

- **Acknowledgment**: within 3 business days of receiving a report.
- **Initial assessment**: within 7 business days.
- **Fix / mitigation**: as soon as a fix is available, coordinated with the
  reporter before public disclosure.

We will credit reporters (unless anonymity is requested) once a fix is
released.

## Scope

This policy covers the CogSeed desktop application and its official
repositories on GitHub. Third-party dependencies are handled through their
respective projects' disclosure processes; please also notify us so we can
track upstream advisories.

## Source Scanning

Scan a clean source snapshot (before installing dependencies) with Gitleaks
8.30.1 or later:

```sh
gitleaks dir . --config .gitleaks.toml --redact
```

The configuration retains the default detection rules. Reviewed exceptions
require the matching rule, exact file path, and exact synthetic test value;
one exception covers an export expression in the unmodified xterm library.
Other values in those same files remain subject to detection. Credential
detection and redaction tests intentionally retain realistic token shapes.

Keep private handoffs, implementation plans, scan output, and local runtime
data outside public source distributions. Official repository URLs, service
domains, security contacts, and third-party copyright notices are public
project metadata and must retain their functional and attribution roles.
