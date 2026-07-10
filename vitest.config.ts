// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/cli.ts"],
      reporter: ["text", "lcov"],
      // TEST-004: gate against coverage regressions. Measured baseline (pre-this
      // change, 33 files / 424 tests): lines 65.94, statements 65.94,
      // functions 63.97, branches 77.58. Thresholds are set a few points BELOW
      // the baseline so CI catches real drops without flaking on minor churn.
      // NOTE: the protocol-e2e harness spawns the server in a child process, so
      // that server-side execution is intentionally NOT counted toward in-process
      // v8 coverage — these thresholds reflect the in-process suite.
      thresholds: {
        lines: 62,
        statements: 62,
        functions: 60,
        branches: 73,
      },
    },
    testTimeout: 10000,
  },
});
