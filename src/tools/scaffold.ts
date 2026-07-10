// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: project_scaffold
 *
 * Materializes a chosen reference architecture into a workspace directory,
 * ready to run locally and deploy to Azure. Called with no `architecture` it
 * lists the available options (agent-guided elicitation). Ports EVAL.md
 * `scaffold-project`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { REFERENCE_ARCHITECTURES, findArchitecture } from "../reference-architectures.js";
import { writeState } from "../state.js";
import type { McpTool } from "../types.js";
interface ScaffoldArgs {
  architecture?: string;
  targetDir?: string;
  projectName?: string;
}

export const scaffoldTool: McpTool = {
  name: "project_scaffold",
  annotations: { localRequired: true },
  description:
    "Scaffold a SharePoint Embedded reference architecture into a project directory (runnable " +
    "locally, deployable to Azure unchanged). Call with no 'architecture' to list available " +
    "options, then call again with the chosen architecture id and a target directory.",
  inputSchema: {
    type: "object" as const,
    properties: {
      architecture: {
        type: "string",
        description: "Reference architecture id (e.g., 'react-spa-functions', 'csharp-web'). Omit to list options.",
      },
      targetDir: { type: "string", description: "Directory to scaffold into. Default: ./<projectName>." },
      projectName: { type: "string", description: "Project name. Default: 'spe-app'." },
    },
  },
  handler: async (args) => {
    const { architecture, targetDir, projectName = "spe-app" } = args as ScaffoldArgs;

    // No architecture → list options (agent-guided elicitation).
    if (!architecture) {
      let text = "### Which reference architecture?\n\n";
      for (const a of REFERENCE_ARCHITECTURES) {
        text += `- **${a.name}** — \`architecture=${a.id}\` · ${a.description}\n`;
      }
      text += "\n> Re-run `project_scaffold` with the chosen `architecture` and a `targetDir`.";
      return { content: [{ type: "text" as const, text }] };
    }

    const arch = findArchitecture(architecture);
    if (!arch) {
      return {
        content: [{ type: "text" as const, text: `Error: unknown architecture '${architecture}'. Run project_scaffold with no architecture to list options.` }],
        isError: true,
      };
    }

    try {
      const dir = resolve(targetDir ?? join(process.cwd(), projectName));
      const files = arch.files(projectName);
      for (const [relPath, contents] of Object.entries(files)) {
        const full = join(dir, relPath);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, contents, "utf-8");
      }
      writeState({ scaffoldArchitecture: arch.id, projectName });

      const fileList = Object.keys(files).map((f) => `- \`${f}\``).join("\n");
      const output =
        `## Scaffolded: ${arch.name}\n\n` +
        `Created project in \`${dir}\`:\n\n${fileList}\n\n` +
        "> Next: `project_hydrate_config` to inject your SPE settings, then `project_run_local` to start it.";
      return { content: [{ type: "text" as const, text: output }] };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      return { content: [{ type: "text" as const, text: `Error scaffolding project: ${msg}` }], isError: true };
    }
  },
};
