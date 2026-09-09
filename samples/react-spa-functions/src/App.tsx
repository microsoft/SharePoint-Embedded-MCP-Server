// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PublicClientApplication,
  InteractionRequiredAuthError,
  type AccountInfo,
} from "@azure/msal-browser";

// SPE settings injected by project_hydrate_config into .env (Vite VITE_* vars).
const cfg = {
  tenantId: import.meta.env.VITE_TENANT_ID ?? "",
  clientId: import.meta.env.VITE_CLIENT_ID ?? "",
  containerTypeId: import.meta.env.VITE_CONTAINER_TYPE_ID ?? "",
  containerId: import.meta.env.VITE_CONTAINER_ID ?? "",
};

const GRAPH = "https://graph.microsoft.com/v1.0";
// Container creation goes through the Graph **beta** endpoint, and the owning app
// (this app, a public client) can create containers on the container type it
// owns when the signed-in user is an owner of that container type.
const GRAPH_BETA = "https://graph.microsoft.com/beta";
const SCOPES = ["https://graph.microsoft.com/FileStorageContainer.Selected"];

const pca = new PublicClientApplication({
  auth: {
    clientId: cfg.clientId,
    authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
    redirectUri: window.location.origin,
  },
  cache: { cacheLocation: "sessionStorage" },
});

// Turn a Microsoft Entra (AAD) sign-in error into clear, actionable guidance for
// the app-registration / redirect-URI failures (AADSTS9002326 cross-origin SPA
// token redemption, AADSTS50011 redirect URI mismatch) that otherwise surface as
// an opaque 400 — almost always a config mismatch on the owning Entra app (often
// a stale .env pointing at the wrong app), not a client bug. This is a
// byte-for-byte copy of the canonical, unit-tested helper in the SPE Builder MCP
// (src/auth-error-guidance.ts); auth-error-guidance.test.ts asserts this sample
// stays in sync. Returns null for unrelated errors.
function interpretAuthError(errorText: string, origin: string): string | null {
  const text = errorText || "";
  const isCrossOrigin = text.includes("AADSTS9002326");
  const isRedirectMismatch = text.includes("AADSTS50011");
  if (!isCrossOrigin && !isRedirectMismatch) {
    return null;
  }
  const cause = isCrossOrigin
    ? "AADSTS9002326: Entra refused to redeem the sign-in code because the request came from a cross-origin Single-Page Application (SPA) caller whose origin is not registered."
    : "AADSTS50011: redirect URI mismatch — this app's current origin is not listed as a redirect URI on the owning Entra app registration.";
  const azBody =
    '"{\\"spa\\":{\\"redirectUris\\":[\\"' + origin + '\\"]}}"';
  return [
    "Sign-in failed: Entra rejected this build's sign-in for its current origin.",
    "",
    cause,
    "",
    "This is almost always a configuration mismatch on the owning Entra app-registration,",
    "not a bug in this app's code. Check these two things, in order:",
    "",
    "1) Is this build signing in as the app you think it is? This SPA authenticates as the",
    "   VITE_CLIENT_ID / VITE_TENANT_ID baked into its .env at build time. If those were",
    "   hydrated from stale or mismatched state, you may have registered the redirect URI on",
    "   a DIFFERENT app than the one signing in. Confirm they match the app you are viewing",
    "   in the portal (Entra ID > App registrations > your app > Overview: Application",
    "   (client) ID and Directory (tenant) ID). If you change .env, rebuild — Vite bakes",
    "   these values in at build time, so a running dev server will not pick up an edit.",
    "",
    "2) Does THAT app list this exact origin as a Single-page application (SPA) redirect URI?",
    "   Look the app up by client id (display names are not unique) and check its spa block:",
    "     az rest --method GET --uri \"https://graph.microsoft.com/v1.0/applications?$filter=appId eq '<VITE_CLIENT_ID>'&$select=appId,spa\"",
    "   If spa.redirectUris does not include the origin below, add it:",
    "",
    "    " + origin,
    "",
    "   Portal: Entra ID > App registrations > (this app) > Authentication >",
    "     Add a platform > Single-page application > Redirect URI:",
    "       " + origin,
    "   or with Azure CLI (replace <objectId> with the app registration object id):",
    "     az rest --method PATCH --uri \"https://graph.microsoft.com/v1.0/applications/<objectId>\" --headers \"Content-Type=application/json\" --body " +
      azBody,
    "",
    "Newly provisioned apps get this SPA redirect URI automatically, so you can also just",
    "re-run provisioning / deploy to (re)apply it. App-registration changes take effect on",
    "the next sign-in but are not applied by client hot-reload, and a changed .env needs a",
    "rebuild.",
  ].join("\n");
}

// Pull the most descriptive text out of an MSAL/Graph error, then interpret it.
// Returns actionable guidance for a known app-registration error, else null.
function explainAuthError(e: unknown): string | null {
  const err = e as { errorCode?: string; errorMessage?: string; message?: string } | null;
  const text =
    [err?.errorCode, err?.errorMessage, err?.message].filter(Boolean).join(" ") || String(e);
  const guidance = interpretAuthError(text, window.location.origin);
  if (guidance) console.error(guidance);
  return guidance;
}

// Humanize a byte count for the file list (e.g. 2048 → "2.0 KB").
function formatSize(bytes?: number): string {
  if (typeof bytes !== "number" || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

// Derive up-to-two-letter initials from a UPN/email for the account avatar.
function initials(username?: string): string {
  const s = (username ?? "").trim();
  if (!s) return "?";
  const namePart = s.split("@")[0];
  const parts = namePart.split(/[.\-_ ]+/).filter(Boolean);
  const chars = parts.length >= 2 ? parts[0][0] + parts[1][0] : namePart.slice(0, 2);
  return chars.toUpperCase();
}

interface Container {
  id: string;
  displayName: string;
  status?: string;
}

interface DriveItem {
  id: string;
  name: string;
  size?: number;
  folder?: unknown;
  webUrl?: string;
}

export function App() {
  const [ready, setReady] = useState(false);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [containers, setContainers] = useState<Container[]>([]);
  const [files, setFiles] = useState<DriveItem[]>([]);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    pca
      .initialize()
      .then(() => {
        const acct = pca.getAllAccounts()[0] ?? null;
        if (acct) {
          pca.setActiveAccount(acct);
          setAccount(acct);
        }
        setReady(true);
      })
      .catch((e) => setError(explainAuthError(e) ?? String(e)));
  }, []);

  const getToken = useCallback(async (): Promise<string> => {
    try {
      const r = await pca.acquireTokenSilent({ scopes: SCOPES, account: account ?? undefined });
      return r.accessToken;
    } catch (e) {
      if (e instanceof InteractionRequiredAuthError) {
        const r = await pca.acquireTokenPopup({ scopes: SCOPES });
        return r.accessToken;
      }
      throw e;
    }
  }, [account]);

  const signIn = useCallback(async () => {
    setError("");
    try {
      const r = await pca.loginPopup({ scopes: SCOPES });
      pca.setActiveAccount(r.account);
      setAccount(r.account);
    } catch (e) {
      setError(explainAuthError(e) ?? `Sign-in failed: ${String(e)}`);
    }
  }, []);

  const signOut = useCallback(async () => {
    await pca.logoutPopup();
    setAccount(null);
    setContainers([]);
    setFiles([]);
  }, []);

  const loadContainers = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const token = await getToken();
      const res = await fetch(
        `${GRAPH}/storage/fileStorage/containers?$filter=containerTypeId eq ${cfg.containerTypeId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const data = await res.json();
      setContainers(data.value ?? []);
    } catch (e) {
      setError(explainAuthError(e) ?? `Could not list containers: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [getToken]);

  const loadFiles = useCallback(
    async (containerId: string) => {
      setBusy(true);
      setError("");
      try {
        const token = await getToken();
        const res = await fetch(`${GRAPH}/drives/${containerId}/root/children`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        const data = await res.json();
        setFiles(data.value ?? []);
      } catch (e) {
        setError(explainAuthError(e) ?? `Could not list files: ${String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [getToken],
  );

  // Create a container of the configured container type. This works when this
  // app is the OWNING APP of the container type and the signed-in user is an
  // owner of it (Microsoft Graph beta). The new container is activated so it is
  // immediately usable.
  const createContainer = useCallback(async () => {
    const name = newName.trim();
    if (!name) {
      setError("Enter a name for the new container.");
      return;
    }
    if (!cfg.containerTypeId) {
      setError("No container type configured (VITE_CONTAINER_TYPE_ID).");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const token = await getToken();
      const res = await fetch(`${GRAPH_BETA}/storage/fileStorage/containers`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: name, containerTypeId: cfg.containerTypeId }),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const created = (await res.json()) as Container;
      // Activate the new container so it is usable right away (best-effort).
      await fetch(`${GRAPH_BETA}/storage/fileStorage/containers/${created.id}/activate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => undefined);
      setNewName("");
      await loadContainers();
    } catch (e) {
      setError(explainAuthError(e) ?? `Could not create container: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [getToken, loadContainers, newName]);

  const configRows = useMemo(
    () => [
      ["Tenant", cfg.tenantId],
      ["Client (owning app)", cfg.clientId],
      ["Container type", cfg.containerTypeId],
      ["Default container", cfg.containerId],
    ],
    [],
  );

  return (
    <div className="app">
      <header className="appbar">
        <div className="appbar__mark" aria-hidden>◈</div>
        <div>
          <div className="appbar__title">SharePoint Embedded</div>
          <div className="appbar__subtitle">Reference app</div>
        </div>
        <div className="appbar__spacer" />
        {account && (
          <div className="account">
            <div className="account__avatar" aria-hidden>{initials(account.username)}</div>
            <span className="account__name">{account.username}</span>
            <button className="btn btn--ghost" onClick={signOut}>Sign out</button>
          </div>
        )}
      </header>

      <main className="main">
        {!ready ? (
          <div className="center-pad">
            <span className="spinner" aria-hidden /> Initializing…
          </div>
        ) : !account ? (
          <section className="hero">
            <div className="hero__glyph" aria-hidden>🗂️</div>
            <h1>Your SharePoint Embedded app</h1>
            <p>
              A runnable React starter scaffolded by the SPE Builder. Sign in to browse and create the
              storage containers of your container type, and explore their files.
            </p>
            <button className="btn btn--primary btn--lg" onClick={signIn}>
              <span aria-hidden>🔐</span> Sign in with Microsoft
            </button>
          </section>
        ) : (
          <>
            <div className="page-head">
              <div>
                <h1>Containers</h1>
                <p>Storage containers in your container type.</p>
              </div>
              <button className="btn btn--ghost" onClick={loadContainers} disabled={busy}>
                {busy ? <span className="spinner" aria-hidden /> : <span aria-hidden>⟳</span>} Refresh
              </button>
            </div>

            <div className="toolbar">
              <label className="field">
                <span className="field__icon" aria-hidden>＋</span>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="New container name"
                  disabled={busy}
                  aria-label="New container name"
                />
              </label>
              <button
                className="btn btn--primary"
                onClick={createContainer}
                disabled={busy || !cfg.containerTypeId}
              >
                Create container
              </button>
            </div>

            {containers.length > 0 ? (
              <div className="grid">
                {containers.map((c) => (
                  <div className="card" key={c.id}>
                    <div className="card__icon" aria-hidden>📦</div>
                    <div className="card__body">
                      <div className="card__title" title={c.displayName}>{c.displayName}</div>
                      <div className="card__meta">
                        <span className="pill pill--ok pill--dot">{c.status ?? "active"}</span>
                      </div>
                    </div>
                    <button
                      className="btn btn--subtle"
                      onClick={() => loadFiles(c.id)}
                      disabled={busy}
                    >
                      Open →
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty">
                <div className="empty__glyph" aria-hidden>📭</div>
                <p>
                  No containers loaded yet. Click <strong>Refresh</strong> to list them, or create your
                  first one above.
                </p>
              </div>
            )}

            {files.length > 0 && (
              <div className="panel">
                <div className="panel__head">
                  <span aria-hidden>🗃️</span> Files
                  <span className="panel__count">
                    {files.length} item{files.length === 1 ? "" : "s"}
                  </span>
                </div>
                {files.map((f) => (
                  <div className="row" key={f.id}>
                    <span className="row__glyph" aria-hidden>{f.folder ? "📁" : "📄"}</span>
                    <span className="row__name">{f.name}</span>
                    <span className="row__size">{f.folder ? "—" : formatSize(f.size)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {error && (
          <div className="callout" role="alert">
            <span className="callout__glyph" aria-hidden>⚠️</span>
            <pre>{error}</pre>
          </div>
        )}

        <details className="details">
          <summary>Connection details</summary>
          <div className="config">
            {configRows.map(([k, v]) => (
              <div className="config__row" key={k}>
                <span className="config__key">{k}</span>
                <span className="config__val">{v || <em>(not set)</em>}</span>
              </div>
            ))}
          </div>
        </details>
      </main>
    </div>
  );
}
