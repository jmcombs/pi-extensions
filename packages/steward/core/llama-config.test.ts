/**
 * The parser is the surface the live CONFIG panel is built on, so it is tested
 * against the captured real `/props` fixtures (the router shape a live
 * `llama-server` actually returns) and, for the branch no live server can
 * produce without a model file, a hand-authored single-model body. Malformed
 * and partial inputs must degrade to em dashes, never `undefined` or `NaN`.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRouterConfig } from "./llama-config.js";

function fixture(name: string): unknown {
  const url = new URL(`./__fixtures__/llama/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

/** The real router `/props`, captured live from llama-server b9960. */
const ROUTER_PROPS = fixture("props-router.json");

const BASE_URL = "http://127.0.0.1:8080";

describe("parseRouterConfig", () => {
  it("maps the real router /props to the five rows the rail shows", () => {
    expect(parseRouterConfig(ROUTER_PROPS, BASE_URL)).toEqual([
      { key: "role", value: "router" },
      { key: "binary", value: "llama-server b9960-a935fbffe" },
      { key: "listen", value: "127.0.0.1:8080" },
      { key: "max models", value: "4" },
      { key: "autoload", value: "off" },
    ]);
  });

  it("reflects models_autoload=true as on", () => {
    const props = { ...(ROUTER_PROPS as Record<string, unknown>), models_autoload: true };
    const autoload = parseRouterConfig(props, BASE_URL).find((row) => row.key === "autoload");
    expect(autoload?.value).toBe("on");
  });

  it("handles a single-model server: no router-only rows, no undefined", () => {
    // Hand-authored — a bare `-m model.gguf` server, not live-verified (that
    // needs a GGUF). llama.cpp reports no role/max_instances/models_autoload
    // here, but does carry a build tag and real generation settings.
    const single = {
      model_path: "/models/qwen.gguf",
      build_info: "b9960-a935fbffe",
      default_generation_settings: { n_ctx: 4096 },
    };
    expect(parseRouterConfig(single, BASE_URL)).toEqual([
      { key: "role", value: "single-model" },
      { key: "binary", value: "llama-server b9960-a935fbffe" },
      { key: "listen", value: "127.0.0.1:8080" },
    ]);
  });

  it("shows em dashes for missing router fields, never undefined or NaN", () => {
    const rows = parseRouterConfig({ role: "router" }, BASE_URL);
    expect(rows).toEqual([
      { key: "role", value: "router" },
      { key: "binary", value: "—" },
      { key: "listen", value: "127.0.0.1:8080" },
      { key: "max models", value: "—" },
      { key: "autoload", value: "—" },
    ]);
    expect(rows.every((row) => row.value !== "undefined" && !row.value.includes("NaN"))).toBe(true);
  });

  it("treats an empty body as a single-model server with an unknown build", () => {
    expect(parseRouterConfig({}, BASE_URL)).toEqual([
      { key: "role", value: "single-model" },
      { key: "binary", value: "—" },
      { key: "listen", value: "127.0.0.1:8080" },
    ]);
  });

  it("does not throw on non-object bodies, still showing listen", () => {
    for (const junk of [null, "oops", 42, [1, 2, 3]]) {
      const rows = parseRouterConfig(junk, BASE_URL);
      expect(rows.find((row) => row.key === "listen")?.value).toBe("127.0.0.1:8080");
    }
  });

  it("ignores a wrong-typed max_instances rather than rendering NaN", () => {
    const props = { role: "router", max_instances: "four" };
    const max = parseRouterConfig(props, BASE_URL).find((row) => row.key === "max models");
    expect(max?.value).toBe("—");
  });

  it("derives listen from the connection, including non-default ports", () => {
    const listen = (base: string) =>
      parseRouterConfig(ROUTER_PROPS, base).find((row) => row.key === "listen")?.value;
    expect(listen("http://127.0.0.1:9099")).toBe("127.0.0.1:9099");
    expect(listen("https://gpu.local:8443")).toBe("gpu.local:8443");
  });
});
