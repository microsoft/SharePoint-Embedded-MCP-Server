// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Reference architecture catalog for the SPE Builder.
 *
 * Each architecture is a small, runnable, Azure-deployable starter that the
 * `project_scaffold` tool materializes and that is also exposed as an MCP Resource
 * (so any MCP client can enumerate/inspect them). The React quick-start is an
 * intentionally minimal starter; the C# full-stack arch deploys the ODSP
 * security-approved azd template (`microsoft/app-with-sharepoint-knowledge`) —
 * Azure Container Apps with a user-assigned managed identity + federated
 * credential (no secrets).
 *
 * The apps themselves are REAL committed projects under `../samples/<id>` (built,
 * linted, and CVE-scanned in CI). They are the single source of truth: the
 * scaffolder reads them here instead of from generated `.ts` string templates,
 * and `samples/` ships in the npm package next to `dist/`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface ReferenceArchitecture {
  id: string;
  name: string;
  description: string;
  language: string;
  /** azd host target for this architecture (e.g., 'staticwebapp', 'appservice'). */
  host: string;
  /** Returns the file map (relative path → contents) for a project name. */
  files: (projectName: string) => Record<string, string>;
}

/**
 * Build an `azure.yaml` (azd) descriptor for a project. The `name`, `language`,
 * and `host` are architecture-specific, so callers MUST pass the values for the
 * scaffolded architecture rather than hard-coding a single host (which would
 * flip, e.g., a C# Container Apps app to a Static Web App). Exported so
 * `project_hydrate_config` can regenerate a descriptor that matches the
 * scaffolded architecture. For `containerapp` hosts a `docker:` build section is
 * emitted so azd builds the image from the project's Dockerfile.
 */
export function buildAzureYaml(name: string, language: string, host: string): string {
  const lines = [
    "# yaml-language-server: $schema=https://raw.githubusercontent.com/Azure/azure-dev/main/schemas/v1.0/azure.yaml.json",
    `name: ${name}`,
    "metadata:",
    "  template: spe-builder-mcp",
    "services:",
    "  web:",
    "    project: .",
    `    language: ${language}`,
    `    host: ${host}`,
  ];
  if (host === "containerapp") {
    lines.push("    docker:", "      path: ./Dockerfile");
  }
  if (host === "staticwebapp") {
    // Vite build output (dist/) that azd deploys to the Static Web App.
    lines.push("    dist: dist");
  }
  lines.push("");
  return lines.join("\n");
}

const SAMPLES_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "samples");

// Build outputs that may exist if a sample was built locally; never scaffold them.
const SAMPLE_SKIP_DIRS = new Set([
  "node_modules", "dist", "bin", "obj", ".publish", ".vs", ".vscode", ".azure", ".git",
]);

/** Read a committed sample app into a `{ relPath -> contents }` map. */
function readSampleTree(architectureId: string): Record<string, string> {
  const root = join(SAMPLES_ROOT, architectureId);
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SAMPLE_SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        const full = join(dir, entry.name);
        files[relative(root, full).split(sep).join("/")] = readFileSync(full, "utf-8");
      }
    }
  };
  walk(root);
  return files;
}

/**
 * Apply the caller's project name to the generic committed sample: the npm
 * package name, the `.csproj` filename, and a freshly-generated `azure.yaml`
 * (host/language are catalog facts, so the descriptor is regenerated rather than
 * string-substituted).
 */
function withProjectName(
  files: Record<string, string>,
  project: string,
  yamlLanguage: string,
  host: string,
): Record<string, string> {
  const out: Record<string, string> = { ...files };

  if (typeof out["package.json"] === "string") {
    try {
      const pkg = JSON.parse(out["package.json"]) as Record<string, unknown>;
      pkg.name = project;
      out["package.json"] = JSON.stringify(pkg, null, 2) + "\n";
    } catch {
      /* leave the committed package.json as-is if it is not valid JSON */
    }
  }

  for (const key of Object.keys(out)) {
    if (key.endsWith(".csproj") && !key.includes("/") && key !== `${project}.csproj`) {
      out[`${project}.csproj`] = out[key];
      delete out[key];
    }
  }

  out["azure.yaml"] = buildAzureYaml(project, yamlLanguage, host);
  return out;
}

export const REFERENCE_ARCHITECTURES: ReferenceArchitecture[] = [
  {
    id: "react-spa-functions",
    name: "React SPA + Azure Functions",
    description: "A React single-page app with an Azure Functions API backend. Deploys to Azure Static Web Apps. (Recommended)",
    language: "ts",
    host: "staticwebapp",
    files: (project) => withProjectName(readSampleTree("react-spa-functions"), project, "js", "staticwebapp"),
  },
  {
    id: "csharp-web",
    name: "C# Web App on Azure Container Apps (security-approved)",
    description:
      "An ASP.NET Core app wired to SPE via Microsoft Graph, deployed to Azure Container Apps " +
      "with a user-assigned managed identity + federated credential (no secrets). Based on the " +
      "ODSP security-approved azd template. Enterprise-friendly.",
    language: "dotnet",
    host: "containerapp",
    files: (project) => withProjectName(readSampleTree("csharp-web"), project, "dotnet", "containerapp"),
  },
];

export function findArchitecture(id: string): ReferenceArchitecture | undefined {
  return REFERENCE_ARCHITECTURES.find((a) => a.id === id);
}
