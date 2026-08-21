<!-- BEGIN MICROSOFT SECURITY.MD V1.0.0 BLOCK -->

## Security

Microsoft takes the security of our software products and services seriously, which
includes all source code repositories in our GitHub organizations.

**Please do not report security vulnerabilities through public GitHub issues.**

For security reporting information, locations, contact information, and policies,
please review the latest guidance for Microsoft repositories at
[https://aka.ms/SECURITY.md](https://aka.ms/SECURITY.md).

<!-- END MICROSOFT SECURITY.MD BLOCK -->

## Private reporting on this repository

This repository uses **GitHub Private Vulnerability Reporting (PVR)**. Reports submitted through
PVR are visible only to repository maintainers — never in public issues, pull request comments,
job logs, workflow artifacts, or the public code scanning surface.

To report a vulnerability you found yourself, use **Security → Report a vulnerability** on this
repository, or follow the Microsoft guidance linked above. Do not open a public issue.

### Automated audit reports

The repository's optional model-assisted security audit
(see [docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md)) submits its validated findings through the
**same** PVR endpoint, and through no other channel. Specifically:

- Automated findings and any exploit detail are **never** written to job logs, workflow artifacts,
  job summaries, pull request annotations, code scanning / SARIF, public issues, Azure DevOps, or
  IcM. There is no fallback surface: if private reporting is unavailable, the audit fails closed
  and publishes nothing.
- Each audited commit produces at most **one aggregate report**, titled
  `SPE automated security audit — <first 12 hex of the audited commit SHA>`.
- Submission is de-duplicated against existing reports in the `triage` and `draft` states by exact
  title match, so re-running the audit for the same commit does not create a duplicate report.
- Reports are drafted as repository security advisories in the private reporting queue and are
  therefore visible only to maintainers. They are advisory input for human triage; they are not
  published advisories and they never gate a pull request.

Public workflow output for a security audit run is limited to one of two literals:
`Security audit: PASS` or
`Security audit: FAIL — details were reported privately to maintainers.`

The model-assisted stage is **disabled by default** and requires explicit maintainer activation,
including PVR being enabled on the repository. See
[docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md) for the full activation prerequisites.