// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  clientClose: vi.fn(),
  transportClose: vi.fn(),
  transport: vi.fn(),
  stderrOn: vi.fn(),
  mkdtemp: vi.fn(),
  rm: vi.fn(),
  exists: vi.fn(),
  build: vi.fn(),
}));
vi.mock("node:fs", () => ({
  existsSync: mocks.exists,
  mkdtempSync: mocks.mkdtemp,
}));
vi.mock("node:fs/promises", () => ({ rm: mocks.rm }));
vi.mock("node:child_process", () => ({ execSync: mocks.build }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = mocks.connect;
    close = mocks.clientClose;
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    stderr = { on: mocks.stderrOn };
    close = mocks.transportClose;
    constructor(options: unknown) { mocks.transport(options); }
  },
}));

import setup, { startProtocolServer } from "../test/protocol-server.js";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.mkdtemp.mockReturnValue("/synthetic-home");
  mocks.connect.mockResolvedValue(undefined);
  mocks.clientClose.mockResolvedValue(undefined);
  mocks.transportClose.mockResolvedValue(undefined);
  mocks.rm.mockResolvedValue(undefined);
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("protocol fixture cleanup", () => {
  it("awaits both resource closures before requesting bounded native filesystem retries", async () => {
    let clientClosed!: () => void;
    let transportClosed!: () => void;
    mocks.clientClose.mockReturnValue(new Promise<void>((resolve) => { clientClosed = resolve; }));
    mocks.transportClose.mockReturnValue(new Promise<void>((resolve) => { transportClosed = resolve; }));
    const server = await startProtocolServer();
    const closing = server.close();
    expect(mocks.transportClose).not.toHaveBeenCalled();
    expect(mocks.rm).not.toHaveBeenCalled();
    clientClosed();
    await vi.waitFor(() => expect(mocks.transportClose).toHaveBeenCalledTimes(1));
    expect(mocks.rm).not.toHaveBeenCalled();
    transportClosed();
    await closing;
    expect(mocks.rm).toHaveBeenCalledExactlyOnceWith(server.isolatedHome, {
      recursive: true, force: true, maxRetries: 5, retryDelay: 100,
    });
  });

  it("does not report teardown complete while native contention retries are pending", async () => {
    let cleanupFinished!: () => void;
    mocks.rm.mockReturnValue(new Promise<void>((resolve) => { cleanupFinished = resolve; }));
    const server = await startProtocolServer();
    let closed = false;
    const closing = server.close().then(() => { closed = true; });
    await vi.waitFor(() => expect(mocks.rm).toHaveBeenCalledTimes(1));
    expect(mocks.rm).toHaveBeenCalledWith(server.isolatedHome, expect.objectContaining({
      recursive: true, maxRetries: 5, retryDelay: 100,
    }));
    expect(closed).toBe(false);
    expect(console.info).toHaveBeenCalledTimes(1);
    cleanupFinished();
    await closing;
    expect(closed).toBe(true);
    expect(console.info).toHaveBeenCalledTimes(2);
  });

  it.each(["EACCES", "EINVAL", "ENOTEMPTY"])("surfaces non-retryable or exhausted %s cleanup errors", async (code) => {
    const error = Object.assign(new Error("Cannot remove isolated home"), { code });
    mocks.rm.mockRejectedValueOnce(error);
    const server = await startProtocolServer();
    await expect(server.close()).rejects.toBe(error);
    expect(mocks.rm).toHaveBeenCalledTimes(1);
    expect(console.info).toHaveBeenCalledTimes(1);
  });

  it.each(["client", "transport"])("still removes the home after a %s close failure", async (resource) => {
    const error = new Error(`${resource} close failed`);
    (resource === "client" ? mocks.clientClose : mocks.transportClose).mockRejectedValueOnce(error);
    const server = await startProtocolServer();
    await expect(server.close()).rejects.toBe(error);
    expect(mocks.transportClose).toHaveBeenCalledTimes(1);
    expect(mocks.rm).toHaveBeenCalledTimes(1);
  });

  it("cleans up failed startup and preserves its original error", async () => {
    const error = new Error("initialize failed");
    mocks.connect.mockRejectedValueOnce(error);
    await expect(startProtocolServer()).rejects.toBe(error);
    expect(mocks.clientClose).toHaveBeenCalledTimes(1);
    expect(mocks.transportClose).toHaveBeenCalledTimes(1);
    expect(mocks.rm).toHaveBeenCalledTimes(1);
  });

  it("reports both startup and filesystem cleanup failures", async () => {
    const startupError = new Error("initialize failed");
    const cleanupError = Object.assign(new Error("Cannot remove home"), { code: "EACCES" });
    mocks.connect.mockRejectedValueOnce(startupError);
    mocks.rm.mockRejectedValueOnce(cleanupError);
    await expect(startProtocolServer()).rejects.toMatchObject({
      name: "AggregateError",
      message: "Protocol startup and cleanup failed",
      errors: [startupError, cleanupError],
    });
  });

  it("uses separate isolated homes and clears existing configuration overrides", async () => {
    for (const key of ["SPE_CLIENT_ID", "SPE_TENANT_ID", "SPE_READ_ONLY", "SPE_TOOLS"]) {
      vi.stubEnv(key, "inherited");
    }
    mocks.mkdtemp.mockReturnValueOnce("/synthetic-home-one").mockReturnValueOnce("/synthetic-home-two");
    const first = await startProtocolServer();
    const second = await startProtocolServer();
    expect(first.client).not.toBe(second.client);
    expect(mocks.transport.mock.calls.map(([options]) => options.env.HOME)).toEqual([
      first.isolatedHome, second.isolatedHome,
    ]);
    for (const [options] of mocks.transport.mock.calls) {
      expect(options.env.USERPROFILE).toBe(options.env.HOME);
      expect(options.env.SPE_DATA_DIR).toBe(join(options.env.HOME, "data"));
      for (const key of ["SPE_CLIENT_ID", "SPE_TENANT_ID", "SPE_READ_ONLY", "SPE_TOOLS"]) {
        expect(options.env).not.toHaveProperty(key);
      }
      expect(options.stderr).toBe("pipe");
    }
    await Promise.all([first.close(), second.close()]);
    expect(mocks.rm.mock.calls.map(([home]) => home)).toEqual([
      first.isolatedHome, second.isolatedHome,
    ]);
  });
});

describe("protocol global setup", () => {
  it("builds missing dist before workers and leaves an existing build alone", () => {
    mocks.exists.mockReturnValueOnce(false).mockReturnValueOnce(true);
    setup();
    setup();
    expect(mocks.build).toHaveBeenCalledExactlyOnceWith("npm run build", {
      cwd: expect.any(String), stdio: "inherit",
    });
    expect(mocks.exists.mock.calls[0][0]).toBe(join(mocks.build.mock.calls[0][1].cwd, "dist", "cli.js"));
  });

  it("surfaces build failures rather than starting workers against missing output", () => {
    mocks.exists.mockReturnValue(false);
    const error = new Error("build failed");
    mocks.build.mockImplementationOnce(() => { throw error; });
    expect(() => setup()).toThrow(error);
  });
});

describe("protocol fixture native filesystem retries", () => {
  it.each([0, 5])("handles transient ENOTEMPTY with maxRetries=%s at the real rmdir boundary", async (maxRetries) => {
    const { execFile } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    // A fresh process ensures Node's lazy rimraf implementation captures this rmdir boundary.
    const script = `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import promises from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      import { join } from "node:path";

      const nativeRmdir = fs.rmdir;
      const nativeRm = promises.rm;
      let home;
      let calls = 0;
      let removed = 0;
      const errors = [];
      const optionsSeen = [];
      fs.rmdir = (path, callback) => {
        if (String(path) !== home) return nativeRmdir(path, callback);
        calls++;
        if (calls <= 2) {
          // Make the real directory nonempty for this native attempt, then release contention.
          const contender = join(home, "teardown-contender");
          fs.writeFileSync(contender, "contention");
          return nativeRmdir(path, (error) => {
            fs.unlinkSync(contender);
            assert.equal(error?.code, "ENOTEMPTY");
            errors.push(error.code);
            callback(error);
          });
        }
        return nativeRmdir(path, (error) => {
          if (!error) removed++;
          callback(error);
        });
      };
      promises.rm = (path, options) => {
        optionsSeen.push(options);
        return nativeRm(path, ${maxRetries === 0 ? "{ ...options, maxRetries: 0 }" : "options"});
      };
      syncBuiltinESMExports();
      const { startProtocolServer } = await import(${JSON.stringify(new URL("../test/protocol-server.ts", import.meta.url).href)});
      const server = await startProtocolServer();
      home = server.isolatedHome;
      try {
        assert.equal(fs.existsSync(home), true);
        let failure;
        try {
          await server.close();
        } catch (error) {
          failure = error;
        }
        assert.deepEqual(optionsSeen, [{
          recursive: true, force: true, maxRetries: 5, retryDelay: 100,
        }]);
        assert.deepEqual(errors, ["ENOTEMPTY", "ENOTEMPTY"]);
        if (${maxRetries} === 0) {
          assert.equal(failure?.code, "ENOTEMPTY");
          assert.equal(calls, 2);
          assert.equal(removed, 0);
          assert.equal(fs.existsSync(home), true);
        } else {
          assert.equal(failure, undefined);
          // Other real writers may also contend; recovery must still perform native removal.
          assert.ok(calls >= 3);
          assert.equal(removed, 1);
          assert.equal(fs.existsSync(home), false);
        }
        console.log("native-retry " + JSON.stringify({
          maxRetries: ${maxRetries}, calls, removed, errors,
          homeExists: fs.existsSync(home), node: process.version, platform: process.platform,
        }));
      } finally {
        const cleanupHome = home;
        home = undefined;
        fs.rmdir = nativeRmdir;
        promises.rm = nativeRm;
        syncBuiltinESMExports();
        await nativeRm(cleanupHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    `;
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script],
        { timeout: 20000 }, (error, stdout, stderr) => {
          if (error) reject(new Error(`Native contention subprocess failed (${error.code})\n${stdout}\n${stderr}`));
          else resolve(stdout);
        });
    });
    expect(stdout).toContain(`"maxRetries":${maxRetries},`);
    expect(stdout).toContain(`"removed":${maxRetries === 0 ? 0 : 1},"errors":["ENOTEMPTY","ENOTEMPTY"]`);
    expect(stdout).toContain(`"homeExists":${maxRetries === 0}`);
    // Keep actual runtime and native-boundary outcomes visible in validation receipts.
    process.stdout.write(stdout);
  }, 30000);
});
