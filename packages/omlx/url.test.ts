import { describe, expect, it } from "vitest";
import { normalizeOmlxServerUrl, omlxInferenceUrl } from "./url.js";

describe("normalizeOmlxServerUrl", () => {
  it.each([
    ["http://127.0.0.1:8000/", "http://127.0.0.1:8000"],
    ["http://127.0.0.1:8000/v1", "http://127.0.0.1:8000"],
    ["http://127.0.0.1:8000/v1/", "http://127.0.0.1:8000"],
    ["http://127.0.0.1:8000?token=1", "http://127.0.0.1:8000"],
    ["http://127.0.0.1:8000#section", "http://127.0.0.1:8000"],
    ["http://127.0.0.1:8000/v1?x=1#y", "http://127.0.0.1:8000"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeOmlxServerUrl(input)).toBe(expected);
  });

  it("rejects non-http protocols", () => {
    expect(() => normalizeOmlxServerUrl("ftp://127.0.0.1:8000")).toThrow(
      "Server URL must use http or https",
    );
  });
});

describe("omlxInferenceUrl", () => {
  it.each([
    ["http://127.0.0.1:8000", "http://127.0.0.1:8000/v1"],
    ["http://127.0.0.1:8000/", "http://127.0.0.1:8000/v1"],
    ["http://127.0.0.1:8000/v1", "http://127.0.0.1:8000/v1"],
    ["http://127.0.0.1:8000/v1?x=1#frag", "http://127.0.0.1:8000/v1"],
  ])("maps %s to the /v1 inference URL", (input, expected) => {
    expect(omlxInferenceUrl(input)).toBe(expected);
  });
});
