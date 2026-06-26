// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * MCP Prompts for the SPE Builder — guided end-to-end flows.
 *
 * Prompts encode agent instructions, including **agent-guided elicitation**
 * (present choices to the user in chat, then call the tool with the
 * selection), so guided flows are consistent across MCP hosts.
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
  {
    name: "setup_standard_billing",
    description: "Guide a developer through standard Azure billing setup for an already-standard SPE container type.",
    arguments: [
      { name: "containerTypeId", description: "Container type ID to attach standard billing to. Defaults from state if omitted.", required: false },
      { name: "region", description: "Azure region for the Microsoft.Syntex account (e.g., eastus).", required: false },
    ],
  },
  {
    name: "scaffold_sample_app",
    description: "Choose and scaffold a reference SPE app, then hydrate its local configuration.",
    arguments: [
      { name: "projectName", description: "Project name to use for scaffolding. Default: spe-app.", required: false },
      { name: "targetDir", description: "Directory to scaffold into. Default is derived from projectName.", required: false },
    ],
  },
  {
    name: "run_local",
    description: "Run a scaffolded and hydrated reference app locally.",
    arguments: [
      { name: "projectDir", description: "Scaffolded project directory. Default: current directory.", required: false },
    ],
  },
  {
    name: "deploy_to_azure",
    description: "Deploy a scaffolded SPE reference app to Azure using azd.",
    arguments: [
      { name: "projectDir", description: "Scaffolded project directory. Default: current directory.", required: false },
      { name: "location", description: "Azure region required by the non-interactive azd deployment (e.g., eastus).", required: false },
    ],
  },
  {
    name: "seed_sample_content",
    description: "Opt into content-plane access and seed sample containers/documents for demos.",
    arguments: [
      { name: "containerTypeId", description: "Container type ID to seed. Defaults from state if omitted.", required: false },
    ],
  },
  {
    name: "cleanup_project",
    description: "Safely clean up resources provisioned by the SPE Builder.",
    arguments: [],
  },
  {
    name: "troubleshoot_auth_or_billing",
    description: "Diagnose Azure CLI sign-in, consent, Conditional Access, billing, and content-access issues.",
    arguments: [
      { name: "symptom", description: "Error text or observed symptom to troubleshoot.", required: false },
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
6. **Seed sample data** — ask if they want sample containers + documents; if yes, explain this is content-plane access, call \`content_access_grant\` with \`confirm=true\` only after user approval, then call \`project_seed_sample_data\`.
7. **Run locally** — ask if they want to run it now; if yes, call \`project_run_local\` and share the local URL.
8. **Deploy** — when the user asks to deploy, call \`project_deploy\` and share the live URL.

Always present choices clearly and wait for the user's selection before proceeding. Use \`docs_search\` if the user asks conceptual SPE questions.`;

const standardBillingGuide = (containerTypeId: string, region: string) => {
  const ct = containerTypeId ? ` with \`containerTypeId=${containerTypeId}\`` : " using the container type from state";
  const loc = region || "eastus";
  return `Guide the developer through **standard Azure billing** for SPE.

Use this flow:
1. Call \`status_get\`. If Azure CLI is not signed in, tell the user to run \`az login --allow-no-subscriptions\`.
2. Call \`azure_subscriptions_list\`; present enabled subscriptions and ask which subscription to bill.
3. Call \`azure_resource_groups_list\` for the selected subscription; present resource groups and ask which one to use.
4. Explain standard billing is irreversible and only works for a container type created with \`billingClassification=standard\`; trial container types cannot be converted.
5. Preview first: call \`billing_setup\`${ct}, selected subscription/resource group, and \`region=${loc}\` without \`confirm\`.
6. If the user explicitly agrees, call \`billing_setup\` again with the same values and \`confirm=true\`.
7. Finish with \`billing_check\` to verify the billing state.

If ARM returns Conditional Access or claims-challenge errors, tell the user to re-run \`az login --scope https://management.core.windows.net//.default --tenant <tenant-id>\` and retry.`;
};

const scaffoldGuide = (projectName: string, targetDir: string) => `Help the developer scaffold a runnable SPE reference app.

Use this flow:
1. Call \`project_scaffold\` with no \`architecture\` to list options.
2. Present the options and ask the user to choose one.
3. Call \`project_scaffold\` again with the chosen \`architecture\`${projectName ? `, \`projectName=${projectName}\`` : ""}${targetDir ? `, and \`targetDir=${targetDir}\`` : ""}.
4. Call \`project_hydrate_config\` for the scaffolded directory so SPE IDs and app settings are written.
5. Offer next steps: \`project_run_local\`, \`project_deploy\`, or sample content via \`seed_sample_content\`.

Do not overwrite user files without highlighting the target directory first.`;

const runLocalGuide = (projectDir: string) => `Run the scaffolded SPE app locally.

Use this flow:
1. Call \`status_get\` and confirm provisioning state is present.
2. If config has not been hydrated, call \`project_hydrate_config\` for ${projectDir ? `\`${projectDir}\`` : "the project directory"}.
3. Call \`project_run_local\`${projectDir ? ` with \`projectDir=${projectDir}\`` : ""}.
4. Share the returned local URL and any sign-in note.

If startup fails, report the tool's actionable error (missing Node/.NET SDK, port conflict, or missing scaffold) and suggest retrying after fixing it.`;

const deployGuide = (projectDir: string, location: string) => `Deploy the SPE reference app to Azure.

Use this flow:
1. Call \`status_get\` and confirm Azure CLI is signed in.
2. Ensure the app is scaffolded and hydrated; if needed, call \`project_hydrate_config\`.
3. Ask for an Azure region if none was provided. \`project_deploy\` needs a \`location\` for non-interactive \`azd up\`.
4. Call \`project_deploy\`${projectDir ? ` with \`projectDir=${projectDir}\`` : ""}${location ? ` and \`location=${location}\`` : ""}.
5. Share the live URL. If the tool reports redirect URI or auth guidance, include it.

Deployment uses Azure resources and may incur cost; get user confirmation before starting.`;

const seedContentGuide = (containerTypeId: string) => `Seed sample SPE content for demos and regression tests.

Use this flow:
1. Explain that seeding creates containers and uploads sample documents, so it is content-plane access.
2. Call \`content_access_grant\` without \`confirm\` if the user has not already opted in; only call it with \`confirm=true\` after explicit user approval.
3. Call \`project_seed_sample_data\`${containerTypeId ? ` with \`containerTypeId=${containerTypeId}\`` : ""}.
4. If the user wants ad-hoc content operations, use \`content_folder_create\`, \`content_file_upload\`, \`content_search\`, \`content_file_preview\`, or \`content_sharing_manage\` after the grant.
5. Remind the user they can revoke content access with \`content_access_revoke\`.

Never call content tools before content access is granted; they are intentionally fail-closed.`;

const CLEANUP_GUIDE = `Guide safe SPE project cleanup.

Use this flow:
1. Call \`project_cleanup\` without \`confirm\` to preview what would be deleted.
2. Explain the result: trial container types and their owning app can be deleted; standard/direct-to-customer resources are protected unless \`deleteStandard=true\`.
3. Ask for explicit confirmation before deletion.
4. If confirmed, call \`project_cleanup\` with \`confirm=true\`. Only pass \`deleteStandard=true\` if the user explicitly asks to delete billed/protected resources.
5. Report what was deleted or preserved.

This is destructive. Never run the confirmed cleanup silently.`;

const troubleshootGuide = (symptom: string) => `Troubleshoot SPE auth, consent, billing, or content-access issues${symptom ? ` for this symptom: ${symptom}` : ""}.

Use this flow:
1. Call \`status_get\` first and inspect Azure CLI sign-in plus recorded provisioning state.
2. For Azure CLI errors, tell the user to run \`az login --allow-no-subscriptions\`; for ARM/standard billing claims challenges, use \`az login --scope https://management.core.windows.net//.default --tenant <tenant-id>\`.
3. For Graph scope/consent errors, explain the owning public-client app needs delegated SPE permissions and admin/user consent.
4. For billing issues, call \`billing_check\`; if standard setup is needed, use \`azure_subscriptions_list\`, \`azure_resource_groups_list\`, then guarded \`billing_setup\`.
5. For new container/container-type/search misses, explain eventual consistency and retry after propagation.
6. For file operation failures, verify \`content_access_grant\` has been confirmed before using content tools.
7. Use \`docs_search\` for authoritative SPE/Graph documentation if the user asks why a requirement exists.`;

function textPrompt(description: string, text: string) {
  return {
    description,
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text },
      },
    ],
  };
}

export function getPromptMessages(name: string, args: Record<string, unknown>) {
  const arg = (key: string) => (typeof args[key] === "string" ? args[key] as string : "");

  switch (name) {
    case "provision_spe_app":
      return textPrompt("Guided SharePoint Embedded app build", PROVISION_GUIDE(arg("idea")));
    case "setup_standard_billing":
      return textPrompt("Guided standard billing setup", standardBillingGuide(arg("containerTypeId"), arg("region")));
    case "scaffold_sample_app":
      return textPrompt("Guided reference app scaffolding", scaffoldGuide(arg("projectName"), arg("targetDir")));
    case "run_local":
      return textPrompt("Guided local run", runLocalGuide(arg("projectDir")));
    case "deploy_to_azure":
      return textPrompt("Guided Azure deployment", deployGuide(arg("projectDir"), arg("location")));
    case "seed_sample_content":
      return textPrompt("Guided sample content seeding", seedContentGuide(arg("containerTypeId")));
    case "cleanup_project":
      return textPrompt("Guided safe cleanup", CLEANUP_GUIDE);
    case "troubleshoot_auth_or_billing":
      return textPrompt("Guided auth and billing troubleshooting", troubleshootGuide(arg("symptom")));
    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
}
