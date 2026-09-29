/**
 * Headroom compress-payload seam. Does not mock headroom-ai and does not call
 * compress() or compressMessages().
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compressPayload } from "./compress.js";
import type { PiMessage } from "./pi-format.js";

const compressSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "compress.ts"),
  "utf8",
);

describe("compressPayload", () => {
  it("compress payload omits system messages on both paths", () => {
    const system = { role: "system", content: "SYSTEM PROMPT BYTES" };
    const user = { role: "user", content: "hello" };

    const nonPi = [system, user] as unknown as PiMessage[];
    const pi = [
      system,
      user,
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "npm test" } },
        ],
      },
      { role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: "ok" }] },
    ] as unknown as PiMessage[];

    for (const payload of [compressPayload(nonPi), compressPayload(pi)]) {
      expect(payload.some((entry) => (entry as { role?: unknown }).role === "system")).toBe(false);
      expect(JSON.stringify(payload)).not.toContain("SYSTEM PROMPT BYTES");
    }

    expect(compressSource).toContain("compress(compressPayload(messages), compressOptions)");
    expect(compressSource).not.toContain("compress(original");
    expect(compressSource).not.toContain("compress(piToOpenAI(");
    expect(compressSource).not.toContain("compress(openAIMessages");
  });
});
