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
// the SERVER-SIDE app-registration / redirect-URI failures (AADSTS9002326
// cross-origin SPA token redemption, AADSTS50011 redirect URI mismatch) that
// otherwise surface as an opaque 400. This is a byte-for-byte copy of the
// canonical, unit-tested helper in the SPE Builder MCP
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
    "Sign-in failed because of a SERVER-SIDE Microsoft Entra app-registration issue.",
    "",
    "This is NOT a bug in this app and NOT a stale or not-reloaded dev server: the",
    "owning Entra app registration is missing a Single-Page Application (SPA) redirect",
    "URI for this app's origin, so re-running the same client build keeps failing.",
    "",
    cause,
    "",
    "Fix: add this app's origin as a Single-page application (SPA) redirect URI on the",
    "owning Entra app registration:",
    "",
    "    " + origin,
    "",
    "How to apply it:",
    "  - Newly provisioned apps: re-run provisioning / deploy — it now adds this SPA",
    "    redirect URI automatically.",
    "  - An app created before that fix (or a deployed origin not yet added): add it",
    "    manually —",
    "      Portal: Entra ID > App registrations > (this app) > Authentication >",
    "        Add a platform > Single-page application > Redirect URI:",
    "          " + origin,
    "      or with Azure CLI (replace <objectId> with the app registration object id):",
    "        az rest --method PATCH --uri \"https://graph.microsoft.com/v1.0/applications/<objectId>\" --headers \"Content-Type=application/json\" --body " +
      azBody,
    "",
    "Entra app-registration changes are server-side: re-provision / redeploy to apply",
    "them. They are NOT picked up by client hot-reload.",
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
    <main style={{ fontFamily: "Segoe UI, system-ui, sans-serif", maxWidth: 880, margin: "2rem auto", padding: "0 1rem" }}>
      <h1>SharePoint Embedded reference app</h1>
      <p style={{ color: "#555" }}>
        A runnable React SPA scaffolded by the SPE Builder MCP. Sign in to browse and create the containers
        (and browse files) of your container type.
      </p>

      <section style={{ background: "#f6f8fa", borderRadius: 8, padding: "1rem", margin: "1rem 0" }}>
        <h2 style={{ marginTop: 0, fontSize: "1rem" }}>Configuration</h2>
        <table style={{ borderCollapse: "collapse" }}>
          <tbody>
            {configRows.map(([k, v]) => (
              <tr key={k}>
                <td style={{ padding: "2px 12px 2px 0", color: "#666" }}>{k}</td>
                <td style={{ padding: 2, fontFamily: "monospace" }}>{v || <em>(not set)</em>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {!ready ? (
        <p>Initializing…</p>
      ) : !account ? (
        <button onClick={signIn} style={btn}>Sign in</button>
      ) : (
        <>
          <p>
            Signed in as <strong>{account.username}</strong>{" "}
            <button onClick={signOut} style={{ ...btn, marginLeft: 8 }}>Sign out</button>
          </p>
          <button onClick={loadContainers} disabled={busy} style={btn}>List containers</button>

          <div style={{ margin: "8px 0", display: "flex", gap: 8, alignItems: "center" }}>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New container name"
              disabled={busy}
              style={{ padding: "6px 8px", minWidth: 220, border: "1px solid #ccc", borderRadius: 4 }}
            />
            <button onClick={createContainer} disabled={busy || !cfg.containerTypeId} style={btn}>Create container</button>
          </div>

          {containers.length > 0 && (
            <ul>
              {containers.map((c) => (
                <li key={c.id}>
                  <code>{c.displayName}</code>{" "}
                  <button onClick={() => loadFiles(c.id)} disabled={busy} style={linkBtn}>files</button>
                </li>
              ))}
            </ul>
          )}

          {files.length > 0 && (
            <>
              <h3>Files</h3>
              <ul>
                {files.map((f) => (
                  <li key={f.id}>
                    {f.folder ? "📁" : "📄"} {f.name}
                    {typeof f.size === "number" ? ` (${f.size} bytes)` : ""}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {error && (
        <pre style={{ background: "#fff3f3", color: "#a40000", padding: "0.75rem", borderRadius: 6, whiteSpace: "pre-wrap" }}>
          {error}
        </pre>
      )}
    </main>
  );
}

const btn: React.CSSProperties = {
  background: "#0078d4",
  color: "white",
  border: "none",
  borderRadius: 4,
  padding: "0.5rem 1rem",
  cursor: "pointer",
};
const linkBtn: React.CSSProperties = {
  background: "transparent",
  color: "#0078d4",
  border: "none",
  cursor: "pointer",
  textDecoration: "underline",
};
