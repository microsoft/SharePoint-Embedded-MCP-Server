// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * MCP Prompts for the SPE Builder — guided end-to-end flows.
 *
 * The `provision_spe_app` prompt encodes the canonical EVAL.md trajectory as
 * agent instructions, including **agent-guided elicitation** (present choices to
 * the user in chat, then call the tool with the selection). This makes the
 * guided experience consistent across all MCP harnesses, regardless of whether
 * the host supports native structured elicitation.
 */

interface PromptDef {
  name: string;
  description: string;
  arguments: Array<{ name: string; description: string; required: boolean }>;
}

export const SPE_PROMPTS: PromptDef[] = [
  {
    name: "provision_spe_app",
    description:
      "Guided end-to-end: build a SharePoint Embedded app from a natural-language idea — " +
      "provision resources, scaffold a reference architecture, run locally, and deploy to Azure.",
    arguments: [
      { name: "idea", description: "What the app should do (e.g., 'manage construction documents for teams').", required: false },
    ],
  },
];

const PROVISION_GUIDE = (idea: string) => `You are helping a developer build a **SharePoint Embedded (SPE)** app${
  idea ? ` that will: ${idea}` : ""
}. Drive this end to end with the SPE Builder MCP tools, pausing to ask the user at each choice point.

Follow this flow:

1. **Check prerequisites** — call \`status_get\`. If not signed in, tell the user to run \`az login --allow-no-subscriptions\`.
2. **Billing** — ask the user: *Trial* (free, 30 days) or *Standard* (Azure subscription)?
   - If **Standard**: call \`azure_subscriptions_list\`, present the options, ask which one; then \`azure_resource_groups_list\` for that subscription, present and ask which one.
3. **Provision** — call \`project_provision\` with the app name, chosen \`billingClassification\`, and (for standard) \`azureSubscriptionId\` + \`resourceGroup\`.
   - If a previously-used owning app is remembered, the tool asks whether to **reuse** it or use a **different** app — present that choice and re-run with \`appSelection\` (\`reuse\` or \`new\`); for a different app also pass \`appDisplayName\` with its name. Never silently reuse the last app.
4. **Choose a reference architecture** — call \`project_scaffold\` with no \`architecture\` first to list options, present them, ask the user, then call \`project_scaffold\` again with the choice and a \`targetDir\`.
5. **Hydrate config** — call \`project_hydrate_config\` targeting the scaffolded project.
6. **Seed sample data** — ask if they want sample containers + documents; if yes, call \`project_seed_sample_data\`.
7. **Run locally** — ask if they want to run it now; if yes, call \`project_run_local\` and share the local URL.
8. **Deploy** — when the user asks to deploy, call \`project_deploy\` and share the live URL.

Always present choices clearly and wait for the user's selection before proceeding. Use \`docs_search\` if the user asks conceptual SPE questions.`;

export function getPromptMessages(name: string, args: Record<string, unknown>) {
  if (name !== "provision_spe_app") {
    throw new Error(`Unknown prompt: ${name}`);
  }
  const idea = typeof args.idea === "string" ? args.idea : "";
  return {
    description: "Guided SharePoint Embedded app build",
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text: PROVISION_GUIDE(idea) },
      },
    ],
  };
}
