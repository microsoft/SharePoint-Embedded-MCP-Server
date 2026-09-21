---
name: Report an SPE MCP issue
description: >-
  Help a user file a high-quality, triage-ready issue for the SharePoint
  Embedded MCP server (microsoft/SharePoint-Embedded-MCP-Server). Use whenever
  someone hits a problem with the server or a scaffolded sample — a failing MCP
  tool call, a scaffolding / build / deploy error, an install or packaging
  problem, wrong or confusing output, a docs gap, or a sign-in / Entra "AADSTS…"
  failure — and wants to report it, or asks "how do I file an issue / bug".
  Picks the right issue-form template, gathers the diagnostics it expects,
  redacts secrets, and drafts a ready-to-submit GitHub issue.
---

# Report an SPE MCP issue

Turn a vague "it's broken" into a triage-ready issue for
`microsoft/SharePoint-Embedded-MCP-Server`, using the repository's issue-form
templates. This works for **any** kind of problem — a failing MCP tool call, a
scaffolding / build / deploy error, an install or packaging issue, unexpected
output, or a docs gap. Most reports use the general **Bug report** form;
**sign-in / `AADSTS…` errors** have a dedicated form because they need a few
extra auth-specific diagnostics.

## 0. Try to resolve it first

Many problems are self-fixable. Before drafting an issue, check
[`docs/TROUBLESHOOTING.md`](../../../docs/TROUBLESHOOTING.md) and the relevant
`README` / `docs` section for whatever is failing — container-type registration
delays, deploy/config, and sign-in all have known fixes there.

The most common self-fix is for **sign-in / `AADSTS…`** errors, which are almost
always a **config mismatch**: the running build signs in with the
`VITE_CLIENT_ID` / `VITE_TENANT_ID` baked into its `.env` at build time, which
points at a *different* app/tenant than the one the user edited in the portal.
Confirm those two values match the app's **Overview** blade and that the sample
was **rebuilt** after any `.env` change (see
["React SPA sign-in fails with AADSTS9002326"](../../../docs/TROUBLESHOOTING.md#react-spa-sign-in-fails-with-aadsts9002326-redirect-uri-already-registered)).
If a known fix resolves it, no issue is needed.

## 1. Classify the issue

Pick the template that fits. Everything except sign-in uses the general **Bug
report** form (`bug_report.yml`):

- A failing **MCP tool call** (error text or a client-facing `correlationId`).
- A **scaffolding / build / local-run** problem in a generated sample.
- A **deployment** problem (e.g. Static Web Apps / Azure).
- An **install / packaging** problem (`npx` / `npm i -g @microsoft/spe-mcp`).
- **Unexpected or confusing output**, or a **documentation** gap.

Use the dedicated **Sign-in / AADSTS** form (`signin_issue.yml`) only when the
symptom is an auth failure — the error text contains `AADSTS`, "sign in",
"redirect URI", or "token", or the failing request is to
`login.microsoftonline.com`.

## 2. Gather diagnostics

Ask for only what's missing; don't re-request what the user already provided.

**For any issue — collect:** what happened (include any client-facing
`correlationId`), steps to reproduce (the prompt / tool calls), expected
behavior, MCP client (e.g. VS Code Copilot), `@microsoft/spe-mcp` version or
commit, OS + Node version, the tool name(s) involved, and the server stderr
lines for the correlation id (`grep <id> spe-mcp.log`).

**If it's a sign-in / AADSTS issue — also collect:**

| Field | How to get it |
|-------|---------------|
| Exact `AADSTS` code + full error text | From the app UI / browser console |
| Token request URL | Browser DevTools → Network → the failing `…/oauth2/v2.0/token` call |
| `VITE_CLIENT_ID`, `VITE_TENANT_ID` | The scaffolded sample's `.env` (or `.env.local`) |
| Portal **client id** + **tenant id** | Entra portal → App registrations → the app → **Overview** |
| Rebuilt after `.env` change? | Ask directly (Vite inlines env at build time) |
| SPA redirect URIs on the `.env` app | `az rest --method GET --url "https://graph.microsoft.com/v1.0/applications?\$filter=appId eq '<VITE_CLIENT_ID>'&\$select=appId,spa" -o json` |
| Guest/member user? | Ask whether they signed in as a guest/external (B2B) user |

## 3. Redact secrets — always

Before drafting anything, strip: client secrets, refresh/access tokens, `az`
output containing credentials, cookies, and authorization headers. Client IDs,
tenant IDs, and redirect URIs are **not** secrets and are needed for triage
(offer to mask the middle of GUIDs if the user considers them sensitive).

## 4. Draft and submit

Prefer opening the prefilled web form so the template's required checkboxes are
honored:

```bash
gh issue create --repo microsoft/SharePoint-Embedded-MCP-Server \
  --web --template bug_report.yml   # or signin_issue.yml for auth errors
```

For a fully non-interactive draft, write the body to a file and run:

```bash
gh issue create --repo microsoft/SharePoint-Embedded-MCP-Server \
  --title "[Bug]: <one-line summary>" \
  --body-file issue.md
```

Structure the body to mirror the chosen template's sections (what happened,
repro steps, expected behavior, versions; for a sign-in issue, add the `.env`
vs. portal comparison). Show the user the drafted title + body and get
confirmation before creating. If `gh` isn't available or auth is restricted,
output the same content and point the user to
[**New issue**](https://github.com/microsoft/SharePoint-Embedded-MCP-Server/issues/new/choose).

## 5. Search for duplicates first

```bash
gh issue list --repo microsoft/SharePoint-Embedded-MCP-Server \
  --search "<key error text or tool name> in:title,body" --state all
```

Search on a distinctive fragment — the tool name, a `correlationId`, or the
`AADSTS` code for sign-in issues. If a matching issue exists, add the new
diagnostics as a comment instead of opening a duplicate.
