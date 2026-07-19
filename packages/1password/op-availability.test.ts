/**
 * Availability-detection policy tests.
 *
 * These verify the *decision logic* of `getOpStatus()` / `is1PasswordAvailable()`:
 * given various `op` probe outcomes and environment, does the code gate on
 * **configuration** (not `op whoami`/`signedIn`)?
 *
 * Testing note: unlike the round-trip suite (`credential-api.test.ts`, which uses
 * a real temp `auth.json` and real `!echo`/`!exit 1` sentinels), this file injects
 * `op` command outcomes by mocking `node:child_process.exec` and manipulates the
 * `OP_*` env vars. That is a deliberate, maintainer-approved exception to the
 * no-mock-external-CLI rule: the goal is a *deterministic* check of the pure
 * gating policy (env precedence, empty-array handling, non-zero/timeout handling,
 * whoami-is-diagnostic-only). The real `op` behavior driving this fix was verified
 * empirically and remains covered by the maintainer-only `op-live` gate — the mock
 * exists to pin the policy table, not to fake the CLI's success path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ExecCb = (err: unknown, result?: { stdout: string; stderr: string }) => void;

interface MockResponse {
  match: string;
  stdout?: string;
  fail?: { code?: number | string | null; killed?: boolean; stderr?: string };
}

const h = vi.hoisted(() => ({
  responses: [] as MockResponse[],
  calls: [] as string[],
}));

vi.mock("node:child_process", () => ({
  exec: (cmd: string, opts: unknown, cb?: ExecCb): void => {
    const callback: ExecCb | undefined = typeof opts === "function" ? (opts as ExecCb) : cb;
    h.calls.push(cmd);
    const r = h.responses.find((x) => cmd.includes(x.match));
    if (!r) {
      callback?.(Object.assign(new Error(`no mock for: ${cmd}`), { code: 1, stderr: "" }));
      return;
    }
    if (r.fail) {
      callback?.(Object.assign(new Error(r.fail.stderr ?? "mock failure"), r.fail));
      return;
    }
    callback?.(null, { stdout: r.stdout ?? "", stderr: "" });
  },
}));

import { is1PasswordAvailable } from "./credential-api.js";
// Imported after the (hoisted) mock so both modules see the mocked child_process.
import { getOpStatus } from "./index.js";

const OP_ENV = ["OP_SERVICE_ACCOUNT_TOKEN", "OP_CONNECT_HOST", "OP_CONNECT_TOKEN"] as const;
let savedEnv: Record<string, string | undefined>;

const VERSION_OK: MockResponse = { match: "--version", stdout: "2.34.1\n" };
const WHOAMI_FAIL: MockResponse = {
  match: "whoami",
  fail: { code: 1, stderr: "account is not signed in" },
};

beforeEach(() => {
  h.responses = [];
  h.calls = [];
  savedEnv = {};
  for (const k of OP_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of OP_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.clearAllMocks();
});

describe("getOpStatus / is1PasswordAvailable — configuration, not session", () => {
  it("THE REGRESSION: whoami exit1 but account list non-empty ⇒ configured, available", async () => {
    h.responses = [
      VERSION_OK,
      WHOAMI_FAIL,
      {
        match: "account list",
        stdout: JSON.stringify([{ url: "x.1password.com", email: "a@b.c" }]),
      },
    ];
    const status = await getOpStatus();
    expect(status.available).toBe(true);
    expect(status.signedIn).toBe(false); // whoami says no...
    expect(status.configured).toBe(true); // ...but an account IS configured
    expect(await is1PasswordAvailable()).toBe(true);
  });

  it("op --version ENOENT ⇒ unavailable ⇒ is1PasswordAvailable false", async () => {
    h.responses = [{ match: "--version", fail: { code: "ENOENT", stderr: "" } }];
    const status = await getOpStatus();
    expect(status.available).toBe(false);
    expect(status.configured).toBe(false);
    expect(await is1PasswordAvailable()).toBe(false);
  });

  it("account list returns empty [] ⇒ not configured", async () => {
    h.responses = [VERSION_OK, WHOAMI_FAIL, { match: "account list", stdout: "[]" }];
    expect((await getOpStatus()).configured).toBe(false);
    expect(await is1PasswordAvailable()).toBe(false);
  });

  it("OP_SERVICE_ACCOUNT_TOKEN set ⇒ configured without consulting account list", async () => {
    process.env.OP_SERVICE_ACCOUNT_TOKEN = "ops_dummy_token";
    h.responses = [VERSION_OK, WHOAMI_FAIL, { match: "account list", stdout: "[]" }];
    expect((await getOpStatus()).configured).toBe(true);
    expect(await is1PasswordAvailable()).toBe(true);
    expect(h.calls.some((c) => c.includes("account list"))).toBe(false);
  });

  it("both OP_CONNECT_HOST + OP_CONNECT_TOKEN ⇒ configured without account list", async () => {
    process.env.OP_CONNECT_HOST = "https://connect.local";
    process.env.OP_CONNECT_TOKEN = "connect_dummy_token";
    h.responses = [VERSION_OK, WHOAMI_FAIL, { match: "account list", stdout: "[]" }];
    expect((await getOpStatus()).configured).toBe(true);
    expect(h.calls.some((c) => c.includes("account list"))).toBe(false);
  });

  it("only OP_CONNECT_HOST (no token) ⇒ falls through to account list", async () => {
    process.env.OP_CONNECT_HOST = "https://connect.local";
    h.responses = [VERSION_OK, WHOAMI_FAIL, { match: "account list", stdout: "[]" }];
    expect((await getOpStatus()).configured).toBe(false);
    expect(h.calls.some((c) => c.includes("account list"))).toBe(true);
  });

  it("account list nonzero/timeout ⇒ not configured, never throws", async () => {
    h.responses = [
      VERSION_OK,
      WHOAMI_FAIL,
      { match: "account list", fail: { code: null, killed: true, stderr: "" } },
    ];
    await expect(getOpStatus()).resolves.toMatchObject({ available: true, configured: false });
    expect(await is1PasswordAvailable()).toBe(false);
  });
});
