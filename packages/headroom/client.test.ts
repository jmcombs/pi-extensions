/**
 * Unit tests for `resolveConfig` — the base-URL / API-key precedence and the
 * injectable `resolveKey` seam that replaced the removed pi credential-storage
 * injection (pi 0.80.8) with `resolveSecret` from `@jmcombs/pi-1password`.
 *
 * No network and no external APIs: the stored-credential lookup is exercised
 * through an injected `resolveKey` stub, and the environment fallbacks through
 * `HEADROOM_BASE_URL` / `HEADROOM_API_KEY`. This is the direct coverage for the
 * seam the 1Password migration introduced (the smoke tests in `index.test.ts`
 * mock `./client.js` wholesale and never reach this precedence logic).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BASE_URL, resolveConfig } from "./client.js";

describe("resolveConfig", () => {
  const savedBaseUrl = process.env.HEADROOM_BASE_URL;
  const savedApiKey = process.env.HEADROOM_API_KEY;

  beforeEach(() => {
    process.env.HEADROOM_BASE_URL = undefined;
    process.env.HEADROOM_API_KEY = undefined;
    delete process.env.HEADROOM_BASE_URL;
    delete process.env.HEADROOM_API_KEY;
  });

  afterEach(() => {
    if (savedBaseUrl === undefined) delete process.env.HEADROOM_BASE_URL;
    else process.env.HEADROOM_BASE_URL = savedBaseUrl;
    if (savedApiKey === undefined) delete process.env.HEADROOM_API_KEY;
    else process.env.HEADROOM_API_KEY = savedApiKey;
  });

  it("defaults the base URL and resolves no key when nothing is configured", async () => {
    // resolveKey stub returns undefined (nothing stored).
    const cfg = await resolveConfig({ resolveKey: async () => undefined });
    expect(cfg.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(cfg.apiKey).toBeUndefined();
  });

  it("reads the stored `headroom` key through the injected resolveKey seam", async () => {
    const resolveKey = vi.fn(async (name: string) =>
      name === "headroom" ? "stored-key" : undefined,
    );
    const cfg = await resolveConfig({ resolveKey });
    expect(resolveKey).toHaveBeenCalledWith("headroom");
    expect(cfg.apiKey).toBe("stored-key");
  });

  it("prefers an explicit apiKey arg over the stored key (precedence: arg → stored)", async () => {
    const resolveKey = vi.fn(async () => "stored-key");
    const cfg = await resolveConfig({ apiKey: "explicit-key", resolveKey });
    expect(cfg.apiKey).toBe("explicit-key");
    // The stored resolver is not consulted when an explicit key is supplied.
    expect(resolveKey).not.toHaveBeenCalled();
  });

  it("falls back to HEADROOM_API_KEY when nothing is stored (precedence: stored → env)", async () => {
    process.env.HEADROOM_API_KEY = "env-key";
    const cfg = await resolveConfig({ resolveKey: async () => undefined });
    expect(cfg.apiKey).toBe("env-key");
  });

  it("prefers the stored key over the environment fallback", async () => {
    process.env.HEADROOM_API_KEY = "env-key";
    const cfg = await resolveConfig({ resolveKey: async () => "stored-key" });
    expect(cfg.apiKey).toBe("stored-key");
  });

  it("resolves the base URL: explicit arg → HEADROOM_BASE_URL → default", async () => {
    const noKey = { resolveKey: async () => undefined };
    expect((await resolveConfig({ baseUrl: "http://explicit:9000", ...noKey })).baseUrl).toBe(
      "http://explicit:9000",
    );

    process.env.HEADROOM_BASE_URL = "http://env:8080";
    expect((await resolveConfig(noKey)).baseUrl).toBe("http://env:8080");

    delete process.env.HEADROOM_BASE_URL;
    expect((await resolveConfig(noKey)).baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it("never throws when the resolver rejects — falls back to env / undefined (LD3)", async () => {
    const resolveKey = async () => {
      throw new Error("resolver blew up");
    };
    await expect(resolveConfig({ resolveKey })).resolves.toEqual({
      baseUrl: DEFAULT_BASE_URL,
      apiKey: undefined,
    });

    process.env.HEADROOM_API_KEY = "env-key";
    await expect(resolveConfig({ resolveKey })).resolves.toEqual({
      baseUrl: DEFAULT_BASE_URL,
      apiKey: "env-key",
    });
  });
});
