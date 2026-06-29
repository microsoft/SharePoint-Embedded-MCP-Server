// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: project_seed_sample_data
 *
 * Creates sample containers and uploads sample documents so the developer (and
 * the agent's closed loop) has data to explore immediately. Ports EVAL.md
 * `seed-sample-data` (e.g., Blueprints / Permits / Site Photos).
 *
 * Requires content-plane access (the owning-app token used for container ops
 * also covers drive writes here). Uses the registered container type from state.
 */

import {
  activateContainer,
  createContainer,
  getContainerDrive,
  uploadSmallFile,
} from "../graph-client.js";
import { readState } from "../state.js";
import { requireContentAccess } from "./content-access.js";
import type { McpTool } from "../types.js";

interface SeedArgs {
  containerTypeId?: string;
}

// A small, realistic sample set (the EVAL.md construction-docs example).
const SAMPLE_CONTAINERS: Array<{ name: string; docs: string[] }> = [
  { name: "Blueprints", docs: ["Floor-Plan-L1.txt", "Floor-Plan-L2.txt", "Elevations.txt", "Site-Layout.txt"] },
  { name: "Permits", docs: ["City-Permit.txt", "Electrical-Inspection.txt", "Plumbing-Inspection.txt", "Occupancy.txt", "Fire-Safety.txt"] },
  { name: "Site Photos", docs: ["Progress-Week1.txt", "Progress-Week2.txt", "Foundation.txt"] },
];

export const seedSampleDataTool: McpTool = {
  name: "project_seed_sample_data",
  annotations: { plane: "content", requiresConsent: true },
  description:
    "Seed sample containers and documents into a SharePoint Embedded setup so you can start " +
    "exploring immediately (e.g., Blueprints, Permits, Site Photos with sample files). Uses the " +
    "registered container type from the current provisioning state.",
  inputSchema: {
    type: "object" as const,
    properties: {
      containerTypeId: { type: "string", description: "Container type ID. Defaults from provisioning state." },
    },
  },
  handler: async (args) => {
    const gate = requireContentAccess();
    if (gate) return gate;

    const state = readState();
    const { containerTypeId = state.containerTypeId } = args as SeedArgs;

    if (!containerTypeId) {
      return {
        content: [{ type: "text" as const, text: "Error: no container type to seed (none in state). Provision an SPE app first." }],
        isError: true,
      };
    }

    try {
      let totalDocs = 0;
      const rows: string[] = [];
      for (const sample of SAMPLE_CONTAINERS) {
        const container = await createContainer(containerTypeId, sample.name);
        if (container.status !== "active") {
          await activateContainer(container.id).catch(() => undefined);
        }
        const drive = await getContainerDrive(container.id);
        for (const doc of sample.docs) {
          await uploadSmallFile(drive.id, `/${doc}`, `Sample document: ${doc}\nContainer: ${sample.name}\n`);
          totalDocs++;
        }
        rows.push(`| 📁 ${sample.name} | ${sample.docs.length} docs |`);
      }

      const output =
        "## Sample Data Seeded\n\n" +
        "| Container | Documents |\n|-----------|-----------|\n" +
        rows.join("\n") +
        `\n\nCreated ${SAMPLE_CONTAINERS.length} containers with ${totalDocs} sample documents.`;

      return { content: [{ type: "text" as const, text: output }] };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      return { content: [{ type: "text" as const, text: `Error seeding sample data: ${msg}` }], isError: true };
    }
  },
};
