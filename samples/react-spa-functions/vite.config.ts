// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite build output goes to dist/, which azd deploys to Azure Static Web Apps.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist" },
  // Dev-server port. Must equal the SPE Builder's LOCAL_DEV_PORT
  // (mcp-server/src/constants.ts) — the single source from which the SPA redirect
  // URI registered on the owning Entra app is derived. If you change
  // it here, change it there too or browser sign-in breaks with AADSTS9002326.
  server: { port: 5173 },
});
