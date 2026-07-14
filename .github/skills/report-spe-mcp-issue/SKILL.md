---
name: Report an SPE MCP issue
description: >-
  Help a user file a high-quality bug report for the SharePoint Embedded MCP
  server (microsoft/SharePoint-Embedded-MCP-Server). Use when someone hits an
  error with the server or a scaffolded sample — especially sign-in / Entra
  "AADSTS…" failures (e.g. AADSTS9002326) — and wants to report it, or asks
  "how do I file an issue / bug". Gathers the exact diagnostics the repo's issue
  templates expect, redacts secrets, and drafts a ready-to-submit GitHub issue.
---

# Report an SPE MCP issue

Turn a vague "it's broken" into a triage-ready issue for
`microsoft/SharePoint-Embedded-MCP-Server`, using the repository's issue-form
templates. Two issue classes are supported: **sign-in / AADSTS errors** and
**general bugs**.

## 0. Try to resolve it first (sign-in errors)

Many sign-in reports are self-fixable. Before drafting an issue for an
`AADSTS…` error, walk the user through
[`docs/TROUBLESHOOTING.md` → "React SPA sign-in fails with AADSTS9002326"](../../../docs/TROUBLESHOOTING.md#react-spa-sign-in-fails-with-aadsts9002326-redirect-uri-already-registered).
The single most common cause is a **config mismatch**: the running build signs in
with the `VITE_CLIENT_ID` / `VITE_TENANT_ID` baked into its `.env` at build time,
which points at a *different* app/tenant than the one the user edited in the
portal. Confirm those two values match the app's **Overview** blade and that the
sample was **rebuilt** after any `.env` change. If that fixes it, no issue is
needed.

## 1. Classify the issue

- Error text contains `AADSTS`, "sign in", "redirect URI", "token", or the
  failing token request is to `login.microsoftonline.com` → **sign-in issue**
  (template `signin_issue.yml`).
- Anything else (a tool call failed, scaffold/build/deploy problem, unexpected
  output) → **general bug** (template `bug_report.yml`).

## 2. Gather diagnostics

Ask for only what's missing; don't re-request what the user already provided.

**Sign-in issue — collect:**

| Field | How to get it |
|-------|---------------|
| Exact `AADSTS` code + full error text | From the app UI / browser console |
| Token request URL | Browser DevTools → Network → the failing `…/oauth2/v2.0/token` call |
| `VITE_CLIENT_ID`, `VITE_TENANT_ID` | The scaffolded sample's `.env` (or `.env.local`) |
| Portal **client id** + **tenant id** | Entra portal → App registrations → the app → **Overview** |
| Rebuilt after `.env` change? | Ask directly (Vite inlines env at build time) |
| SPA redirect URIs on the `.env` app | `az rest --method GET --url "https://graph.microsoft.com/v1.0/applications?\$filter=appId eq '<VITE_CLIENT_ID>'&\$select=appId,spa" -o json` |
| Guest/member user? | Ask whether they signed in as a guest/external (B2B) user |
| MCP client + server version | e.g. VS Code Copilot; `@microsoft/spe-mcp` version or commit |

**General bug — collect:** what happened (incl. any `correlationId`), steps to
reproduce (the prompt/tool calls), expected behavior, MCP client, server version,
OS + Node version, the tool name(s) involved, and server stderr lines for the
correlation id (`grep <id> spe-mcp.log`).

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
  --web --template signin_issue.yml   # or bug_report.yml
```

For a fully non-interactive draft, write the body to a file and run:

```bash
gh issue create --repo microsoft/SharePoint-Embedded-MCP-Server \
  --title "[Sign-in]: AADSTS9002326 — <one-line summary>" \
  --body-file issue.md
```

Structure the body to mirror the chosen template's sections (Summary, the
`.env` vs. portal comparison for sign-in, repro steps, versions). Show the user
the drafted title + body and get confirmation before creating. If `gh` isn't
available or auth is restricted, output the same content and point the user to
[**New issue**](https://github.com/microsoft/SharePoint-Embedded-MCP-Server/issues/new/choose).

## 5. Search for duplicates first

```bash
gh issue list --repo microsoft/SharePoint-Embedded-MCP-Server \
  --search "AADSTS9002326 in:title,body" --state all
```

If a matching issue exists, add the new diagnostics as a comment instead of
opening a duplicate.
