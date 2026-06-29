import { describe, expect, it } from "vitest";
import {
  type AutoRetrieveClient,
  augmentWithAutoRetrieve,
  collectMarkers,
  latestUserQuery,
} from "./autoretrieve.js";
import { type PiMessage, rewriteRetrieveMarker } from "./pi-format.js";

const LOG = [
  "2026-06-28 11:00:01 INFO  gateway routed alice /api/x -> 200 in 5ms",
  "2026-06-28 11:00:49 INFO  gateway routed carol /api/pay -> upstream node=ip-10-4-22-87 build=rel-2026.06.28-a3f9c12 region=us-west-2 in 38ms",
  "2026-06-28 11:00:50 INFO  gateway routed bob /api/y -> 200 in 4ms",
].join("\n");

/** A stub retrieve client returning a fixed original for any hash. */
function stubClient(original: string, calls: string[] = []): AutoRetrieveClient {
  return {
    async retrieve(hash: string) {
      calls.push(hash);
      return {
        originalContent: original,
        toolName: "read_file",
        originalTokens: 999,
        originalItemCount: 3,
        compressedItemCount: 0,
        retrievalCount: 1,
        // biome-ignore lint/suspicious/noExplicitAny: minimal RetrieveResult stub
      } as any;
    },
  };
}

const userMsg = (text: string): PiMessage =>
  ({ role: "user", content: text }) as unknown as PiMessage;
const markerMsg = (hash: string): PiMessage =>
  ({
    role: "toolResult",
    toolCallId: "tc1",
    content: `[300 lines compressed to 0. Retrieve more: hash=${hash}]`,
  }) as unknown as PiMessage;

describe("latestUserQuery", () => {
  it("returns the last user message text", () => {
    expect(latestUserQuery([markerMsg("abc123"), userMsg("what is the region?")])).toBe(
      "what is the region?",
    );
  });

  it("returns '' when the last message is not a user turn", () => {
    expect(latestUserQuery([userMsg("hi"), markerMsg("abc123")])).toBe("");
    expect(latestUserQuery([])).toBe("");
  });
});

describe("collectMarkers", () => {
  it("finds CCR hashes newest-first", () => {
    const markers = collectMarkers([
      markerMsg("aaaaaa"),
      userMsg("noise"),
      markerMsg("bbbbbb"),
      userMsg("q"),
    ]);
    expect(markers.map((m) => m.hash)).toEqual(["bbbbbb", "aaaaaa"]);
  });

  it("returns [] when no markers present", () => {
    expect(collectMarkers([userMsg("a"), userMsg("b")])).toEqual([]);
  });

  it("ignores a stray hash= that is not a CCR marker (no 'compressed to')", () => {
    // A user mentioning a git hash must not be mistaken for a marker (F2).
    expect(collectMarkers([userMsg("what does commit hash=abcdef1234 mean?")])).toEqual([]);
  });

  it("matches the rewritten directive marker form (post rewriteRetrieveMarker)", () => {
    // Production text reaching collectMarkers is the rewritten directive, not
    // the raw "Retrieve more: hash=" phrasing.
    const rewritten = rewriteRetrieveMarker(
      "[300 lines compressed to 0. Retrieve more: hash=1b55ac35e8690d5a78a3afa1]",
    );
    expect(rewritten).toContain("headroom_retrieve");
    const markers = collectMarkers([
      { role: "toolResult", toolCallId: "tc1", content: rewritten } as unknown as PiMessage,
      userMsg("q"),
    ]);
    expect(markers).toEqual([{ index: 0, hash: "1b55ac35e8690d5a78a3afa1" }]);
  });
});

describe("augmentWithAutoRetrieve", () => {
  it("injects the matching line next to the marker on a recall question", async () => {
    const calls: string[] = [];
    const messages = [
      markerMsg("deadbeef"),
      userMsg("In that gateway log, what was the upstream node hostname, build tag, and region?"),
    ];
    const res = await augmentWithAutoRetrieve(messages, stubClient(LOG, calls));

    expect(calls).toEqual(["deadbeef"]);
    expect(res.injectedMarkers).toBe(1);
    expect(res.injectedLines).toBe(1);
    const injected = String((res.messages[0] as { content: unknown }).content);
    expect(injected).toContain("ip-10-4-22-87");
    expect(injected).toContain("rel-2026.06.28-a3f9c12");
    expect(injected).toContain("us-west-2");
    // The original marker text is preserved (we append, not replace).
    expect(injected).toContain("hash=deadbeef");
    // The user message is untouched.
    expect(res.messages[1]).toBe(messages[1]);
    // Copy-on-write (LD8): the injected slot is a NEW object and the original
    // marker message is not mutated.
    expect(res.messages[0]).not.toBe(messages[0]);
    expect(String((messages[0] as { content: unknown }).content)).toBe(
      "[300 lines compressed to 0. Retrieve more: hash=deadbeef]",
    );
  });

  it("is a no-op when the latest turn is not a user question", async () => {
    const messages = [userMsg("q"), markerMsg("deadbeef")];
    const res = await augmentWithAutoRetrieve(messages, stubClient(LOG));
    expect(res.injectedLines).toBe(0);
    expect(res.messages).toBe(messages);
  });

  it("is a no-op when the query matches no crushed line", async () => {
    const messages = [markerMsg("deadbeef"), userMsg("what is the capital of France?")];
    const res = await augmentWithAutoRetrieve(messages, stubClient(LOG));
    expect(res.injectedLines).toBe(0);
    expect(res.messages).toBe(messages);
  });

  it("is a no-op when there are no markers", async () => {
    const messages = [userMsg("anything about region us-west-2?")];
    const res = await augmentWithAutoRetrieve(messages, stubClient(LOG));
    expect(res.injectedLines).toBe(0);
    expect(res.messages).toBe(messages);
  });

  it("never throws when retrieve fails — skips the marker", async () => {
    const throwing: AutoRetrieveClient = {
      async retrieve() {
        throw new Error("proxy down");
      },
    };
    const messages = [markerMsg("deadbeef"), userMsg("region for the upstream node?")];
    const res = await augmentWithAutoRetrieve(messages, throwing);
    expect(res.injectedLines).toBe(0);
    expect(res.messages).toBe(messages);
  });

  it("respects maxMarkers (newest first)", async () => {
    const calls: string[] = [];
    const messages = [
      markerMsg("a00001"),
      markerMsg("b00002"),
      markerMsg("c00003"),
      userMsg("upstream node region build gateway routed"),
    ];
    await augmentWithAutoRetrieve(messages, stubClient(LOG, calls), { maxMarkers: 2 });
    expect(calls).toEqual(["c00003", "b00002"]);
  });
});
