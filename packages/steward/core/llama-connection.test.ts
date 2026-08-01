/**
 * Connection resolution is the only place host wiring meets configuration, so
 * its precedence has to be exact and its feature detection has to survive a host
 * that offers no provider auth at all. The URL normalizer is a faithful copy of
 * Pi's, and is pinned to the same behaviour here.
 */

import { describe, expect, it } from "vitest";
import type { ConnectionContext } from "./llama-connection.js";
import {
  listenAddress,
  normalizeLlamaServerUrl,
  resolveLlamaConnection,
} from "./llama-connection.js";

/** A stub context whose provider auth returns a fixed result (or nothing). */
function ctxWith(
  result: { auth: { apiKey?: string; baseUrl?: string }; env?: Record<string, string> } | undefined,
): ConnectionContext {
  return { modelRegistry: { getProviderAuth: () => Promise.resolve(result) } };
}

describe("normalizeLlamaServerUrl", () => {
  it("strips a trailing slash", () => {
    expect(normalizeLlamaServerUrl("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080");
  });

  it("strips a /v1 inference suffix", () => {
    expect(normalizeLlamaServerUrl("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080");
    expect(normalizeLlamaServerUrl("http://127.0.0.1:8080/v1/")).toBe("http://127.0.0.1:8080");
  });

  it("keeps https and a non-default port", () => {
    expect(normalizeLlamaServerUrl("https://gpu.local:8443/v1")).toBe("https://gpu.local:8443");
  });

  it("rejects a non-http(s) URL", () => {
    expect(() => normalizeLlamaServerUrl("ftp://127.0.0.1")).toThrow(/http or https/);
    expect(() => normalizeLlamaServerUrl("file:///etc/passwd")).toThrow(/http or https/);
  });
});

describe("listenAddress", () => {
  it("returns host:port, omitting a default port", () => {
    expect(listenAddress("http://127.0.0.1:8080")).toBe("127.0.0.1:8080");
    expect(listenAddress("https://gpu.local:8443")).toBe("gpu.local:8443");
    expect(listenAddress("https://gpu.local")).toBe("gpu.local");
  });

  it("falls back to the raw string on an unparseable URL", () => {
    expect(listenAddress("not a url")).toBe("not a url");
  });
});

describe("resolveLlamaConnection", () => {
  it("prefers provider env LLAMA_BASE_URL over the credential baseUrl", async () => {
    const ctx = ctxWith({
      auth: { apiKey: "secret", baseUrl: "http://10.0.0.9:8080" },
      env: { LLAMA_BASE_URL: "http://127.0.0.1:9090/v1" },
    });
    const connection = await resolveLlamaConnection(ctx, {});
    expect(connection).toEqual({ baseUrl: "http://127.0.0.1:9090", apiKey: "secret" });
  });

  it("uses the credential baseUrl when provider env is absent", async () => {
    const ctx = ctxWith({ auth: { apiKey: "k", baseUrl: "http://10.0.0.9:8080/" } });
    const connection = await resolveLlamaConnection(ctx, {});
    expect(connection).toEqual({ baseUrl: "http://10.0.0.9:8080", apiKey: "k" });
  });

  it("treats an empty env LLAMA_BASE_URL as unset and uses the credential baseUrl", async () => {
    // Pi's resolver treats "" as absent; a plain `??` would let it shadow the
    // configured credential and drop us onto the loopback default.
    const ctx = ctxWith({
      auth: { apiKey: "k", baseUrl: "http://10.0.0.9:8080" },
      env: { LLAMA_BASE_URL: "" },
    });
    const connection = await resolveLlamaConnection(ctx, {});
    expect(connection).toEqual({ baseUrl: "http://10.0.0.9:8080", apiKey: "k" });
  });

  it("defaults to loopback:8080 with an empty key when nothing is configured", async () => {
    const ctx = ctxWith({ auth: {} });
    const connection = await resolveLlamaConnection(ctx, {});
    expect(connection).toEqual({ baseUrl: "http://127.0.0.1:8080", apiKey: "" });
  });

  it("falls back to the environment on a host without modelRegistry", async () => {
    const connection = await resolveLlamaConnection(
      {},
      { LLAMA_BASE_URL: "http://192.168.1.5:8080", LLAMA_API_KEY: "envkey" },
    );
    expect(connection).toEqual({ baseUrl: "http://192.168.1.5:8080", apiKey: "envkey" });
  });

  it("falls back to the environment when provider auth resolution throws", async () => {
    const ctx: ConnectionContext = {
      modelRegistry: {
        getProviderAuth: () => Promise.reject(new Error("no credentials")),
      },
    };
    const connection = await resolveLlamaConnection(ctx, {
      LLAMA_BASE_URL: "http://127.0.0.1:7000",
    });
    expect(connection).toEqual({ baseUrl: "http://127.0.0.1:7000", apiKey: "" });
  });

  it("defaults cleanly when neither a host capability nor env is present", async () => {
    const connection = await resolveLlamaConnection(undefined, {});
    expect(connection).toEqual({ baseUrl: "http://127.0.0.1:8080", apiKey: "" });
  });

  it("degrades a malformed override to the default rather than throwing", async () => {
    const connection = await resolveLlamaConnection({}, { LLAMA_BASE_URL: "ftp://nope" });
    expect(connection.baseUrl).toBe("http://127.0.0.1:8080");
  });
});
