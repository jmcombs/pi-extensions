/**
 * The parser's contract, exercised against line shapes copied verbatim from a
 * real `/tmp/llama-router.log` (15,842 lines, 16 router boots, four days).
 *
 * Two of these tests exist because an earlier design got them wrong. The grammar
 * does NOT require a `<component> <fn>:` pair — 50 real lines carry no component
 * at all, and *every* line of a fatal model-load failure is in that class, so a
 * parser that requires it fails exactly when an operator needs it most. And a
 * line with no level letter is INFO, not "unknown": that is what llama.cpp means
 * by it, and 98.95% of a real corpus is INFO anyway.
 */

import { describe, expect, it } from "vitest";
import { type ParsedLogLine, parseLogLine } from "./log-parse.js";

/** Parses a run of lines the way the tailer does, threading `previous` through. */
function parseRun(raws: readonly string[]): ParsedLogLine[] {
  const out: ParsedLogLine[] = [];
  let previous: ParsedLogLine | null = null;
  for (const raw of raws) {
    previous = parseLogLine(raw, previous);
    out.push(previous);
  }
  return out;
}

describe("parseLogLine", () => {
  it("reads a router line: no port prefix, elapsed, level, free-form message", () => {
    const line = parseLogLine(
      "1401.19.775.771 I srv  proxy_reques: proxying request to model gpt-oss-20b on port 62354",
    );

    expect(line.origin).toBe("router");
    expect(line.port).toBeNull();
    expect(line.level).toBe("INFO");
    // The elapsed stamp and the level letter are stripped; everything else is
    // verbatim, because that is exactly what the console renders.
    expect(line.message).toBe(
      "srv  proxy_reques: proxying request to model gpt-oss-20b on port 62354",
    );
    expect(line.kind).toBe("proxy");
    expect(line.modelName).toBe("gpt-oss-20b");
    expect(line.namedPort).toBe(62354);
  });

  it("reads a child line by the `[port]` prefix the router prepends", () => {
    const line = parseLogLine(
      "[62354] 1408.02.762.105 I slot print_timing: id  0 | task 81259 | prompt eval time =     191.34 ms /    74 tokens (    2.59 ms per token,   386.74 tokens per second)",
    );

    expect(line.origin).toBe("child");
    expect(line.port).toBe(62354);
    expect(line.level).toBe("INFO");
    expect(line.kind).toBe("event");
    // A child line names no model — its port is the only attribution there is.
    expect(line.modelName).toBeNull();
    expect(line.message.startsWith("slot print_timing: id  0 | task 81259 |")).toBe(true);
  });

  it("reads library lines that carry no component at all", () => {
    // The class the naive `<comp> <fn>:` grammar drops on the floor.
    const gguf = parseLogLine(
      "[53730] 0.00.051.592 E gguf_init_from_file: failed to open GGUF file '/models/broken.gguf' (No such file or directory)",
    );
    expect(gguf.level).toBe("ERROR");
    expect(gguf.origin).toBe("child");
    expect(gguf.port).toBe(53730);
    expect(gguf.message).toBe(
      "gguf_init_from_file: failed to open GGUF file '/models/broken.gguf' (No such file or directory)",
    );

    const override = parseLogLine(
      "[50795] 0.00.257.369 W load: override 'tokenizer.ggml.add_bos_token' to 'true' for Gemma4",
    );
    expect(override.level).toBe("WARN");
    expect(override.message).toBe(
      "load: override 'tokenizer.ggml.add_bos_token' to 'true' for Gemma4",
    );
    expect(override.kind).toBe("event");

    const kv = parseLogLine(
      "[51302] 0.00.261.028 W llama_kv_cache: layer   3: sharing with layer 59. k = 0x583800000, v = 0x594800000",
    );
    expect(kv.level).toBe("WARN");
    expect(kv.message.startsWith("llama_kv_cache: layer   3:")).toBe(true);
  });

  it("reads the whole fatal model-load block, which is comp-less end to end", () => {
    const block = parseRun([
      "[53730] 0.00.051.592 E gguf_init_from_file: failed to open GGUF file '/models/broken.gguf' (No such file or directory)",
      "[53730] 0.00.051.700 E llama_model_load: error loading model: llama_model_loader: failed to load model from /models/broken.gguf",
      "[53730] 0.00.051.724 E common_fit_params: encountered an error while trying to fit params to free device memory: unable to load model",
      "[53730] 0.00.051.780 E srv  llama_server: exiting due to model loading error",
      // The router's own summary of that failure is INFO. Only the status number
      // says it failed, which is why nothing here rewrites the level.
      "1408.41.980.112 I srv    operator(): instance name=broken-model exited with status 1",
    ]);

    expect(block.slice(0, 4).every((line) => line.level === "ERROR")).toBe(true);
    expect(block.slice(0, 4).every((line) => line.origin === "child")).toBe(true);
    expect(block[4]?.level).toBe("INFO");
    expect(block[4]?.origin).toBe("router");
    expect(block[4]?.modelName).toBe("broken-model");
  });

  it("treats a line with no level letter as INFO", () => {
    // The IPC records are the only level-less lines a real router writes: no
    // elapsed stamp either, and the longest lines in the file.
    const ipc = parseLogLine(
      '[53691] cmd_child_to_router:state:{"state":"ready","payload":{"id":"qwen3.6-35b-a3b","meta":{"n_ctx":131072}}}',
    );
    expect(ipc.level).toBe("INFO");
    expect(ipc.origin).toBe("child");
    expect(ipc.port).toBe(53691);
    expect(ipc.kind).toBe("event");
    expect(ipc.message.startsWith("cmd_child_to_router:state:")).toBe(true);

    // `--no-log-prefix --no-log-timestamps` strips both leading fields.
    const bare = parseLogLine("srv  llama_server: model loaded");
    expect(bare.level).toBe("INFO");
    expect(bare.origin).toBe("router");
    expect(bare.message).toBe("srv  llama_server: model loaded");
  });

  it("maps every level letter, and only those letters", () => {
    expect(parseLogLine("0.00.000.001 I x").level).toBe("INFO");
    expect(parseLogLine("0.00.000.001 W x").level).toBe("WARN");
    expect(parseLogLine("0.00.000.001 E x").level).toBe("ERROR");
    expect(parseLogLine("0.00.000.001 D x").level).toBe("DEBUG");
    // A capital that is not a level stays part of the message.
    const other = parseLogLine("0.00.000.001 X marks the spot");
    expect(other.level).toBe("INFO");
    expect(other.message).toBe("X marks the spot");
  });

  it("tags the contiguous launch-args run, but not the header that opens it", () => {
    const run = parseRun([
      "0.08.094.079 I srv          load: spawning server instance with name=gpt-oss-20b on port 49534",
      "0.08.094.095 I srv          load: spawning server instance with args:",
      "0.08.094.100 I srv          load:   /opt/homebrew/bin/llama-server",
      "0.08.094.104 I srv          load:   --ctx-size",
      "0.08.094.108 I srv          load:   131072",
      // The run ends the moment a line does not look like a continuation.
      "[49534] 0.00.080.351 I cmn  common_param: common_params_print_info: verbosity = 3",
      "0.08.099.000 I srv          load:   --stray",
    ]);

    expect(run.map((line) => line.kind)).toEqual([
      "event",
      "event",
      "args",
      "args",
      "args",
      "event",
      // A `load:` line outside a run is an ordinary line, not a fold member:
      // membership is positional, exactly as the block is emitted.
      "event",
    ]);
    // The spawn line names the model AND the port, which is what lets a child
    // that spawns while Steward is watching be attributed immediately.
    expect(run[0]?.modelName).toBe("gpt-oss-20b");
    expect(run[0]?.namedPort).toBe(49534);
    // The args block itself is router-wide: it is the command line, not a model.
    expect(run.slice(2, 5).every((line) => line.modelName === null)).toBe(true);
  });

  it("keeps an args run together when the prefix is switched off", () => {
    const run = parseRun([
      "srv          load: spawning server instance with args:",
      "  --ctx-size",
      "  131072",
    ]);
    expect(run.map((line) => line.kind)).toEqual(["event", "args", "args"]);
  });

  it("tags the in-flight generation rate line", () => {
    const rate = parseLogLine(
      "[62354] 25.50.900.199 I slot print_timing: id  0 | task 63276 | n_decoded =    764, tg =  84.60 t/s, tg_3s =  83.42 t/s",
    );
    expect(rate.kind).toBe("rate");
    expect(rate.origin).toBe("child");

    // The completion timings are NOT rate lines: they close a request.
    const total = parseLogLine(
      "[62354] 1408.02.762.108 I slot print_timing: id  0 | task 81259 |       total time =    1064.45 ms /   194 tokens",
    );
    expect(total.kind).toBe("event");
  });

  it("tags every proxied-request line, whichever way it is phrased", () => {
    expect(
      parseLogLine("1401.19.775.771 I srv  proxy_reques: proxying request to model M on port 1")
        .kind,
    ).toBe("proxy");
    expect(parseLogLine("I srv  proxy_reques: something else entirely").kind).toBe("proxy");
    expect(parseLogLine("0.00.000.001 I proxying request to model M").kind).toBe("proxy");
  });

  it("attributes router lines that name a model, and nothing else", () => {
    const unload = parseLogLine(
      "1408.23.810.881 I srv        unload: stopping model instance name=gemma-4-26B-A4B-it-Q8_0",
    );
    expect(unload.modelName).toBe("gemma-4-26B-A4B-it-Q8_0");
    expect(unload.namedPort).toBeNull();

    const lru = parseLogLine(
      "0.09.000.000 I srv    unload_lru: models_max limit reached, removing LRU name=gemma-4-26B-A4B-it-Q8_0",
    );
    expect(lru.modelName).toBe("gemma-4-26B-A4B-it-Q8_0");

    // Model ids really do contain slashes and colons.
    const slashes = parseLogLine(
      "0.08.094.079 I srv          load: spawning server instance with name=ggml-org/Qwen3-0.6B-GGUF:Q4_0 on port 51302",
    );
    expect(slashes.modelName).toBe("ggml-org/Qwen3-0.6B-GGUF:Q4_0");
    expect(slashes.namedPort).toBe(51302);

    // The boot banner and the preset catalogue name nobody. 26% of a filtered
    // real log is like this, and inventing an owner for it would be a lie.
    const banner = parseLogLine(
      "0.00.079.697 I srv  llama_server: starting server in router mode. models will be automatically loaded on-demand",
    );
    expect(banner.modelName).toBeNull();
    expect(banner.origin).toBe("router");
  });

  it("never throws, whatever it is handed", () => {
    const odd = [
      "",
      "   ",
      "[not-a-port] 0.00.000.001 I srv x",
      "[0] 0.00.000.001 I srv x",
      "  binary-ish",
      "]]] {{{ ???",
      "0.00.000.001",
      `[53691] ${"x".repeat(5000)}`,
    ];
    for (const raw of odd) {
      const line = parseLogLine(raw);
      expect(line.level).toBe("INFO");
      expect(typeof line.message).toBe("string");
      expect(line.kind).toBe("event");
    }
    // A malformed port prefix is message text, not a child line.
    expect(parseLogLine("[not-a-port] 0.00.000.001 I srv x").origin).toBe("router");
    // `[0]` is not a port either — port 0 means "not listening".
    expect(parseLogLine("[0] 0.00.000.001 I srv x").port).toBeNull();
  });

  it("survives colours and CRLF, which a non-file source can deliver", () => {
    const esc = String.fromCharCode(27);
    const coloured = parseLogLine(
      `${esc}[0;33m0.00.081.265 W srv  llama_server: NOTE: router mode is experimental${esc}[0m\r`,
    );
    expect(coloured.level).toBe("WARN");
    expect(coloured.message).toBe("srv  llama_server: NOTE: router mode is experimental");
  });

  it("does not mistake the elapsed stamp for a time, however long the uptime", () => {
    // The leading field is total minutes and grows past 59; it never rolls into
    // an hours field, and it never becomes a timestamp — it is per-process and
    // not comparable across processes, so it stays inside the message.
    const long = parseLogLine("1408.02.766.799 I srv  proxy_reques: proxying request to model M");
    expect(long.message.startsWith("srv  proxy_reques:")).toBe(true);
    expect(long.message).not.toContain("1408.02.766.799");
  });

  it("strips an elapsed stamp of any minutes width, because the field never wraps", () => {
    // llama.cpp prints the stamp "%d.%02d.%03d.%03d" from a minute counter, so
    // only the last three fields are fixed-width. Everything from a one-minute
    // child to a four-digit-minute router has to lose the same field.
    const widths = [
      ["0.00.051.592", "gguf_init_from_file: failed to open GGUF file"],
      ["9.07.001.000", "srv    operator(): task done"],
      ["99.59.999.999", "srv  llama_server: the last two-digit minute"],
      // Past 100 minutes the field simply grows; 180 is a three-hour process.
      ["180.05.123.456", "srv  proxy_reques: proxying request to model gpt-oss-20b"],
      // The longest-running boot in the real corpus reached 1597 minutes.
      ["1597.42.318.004", "srv        unload: stopping model instance name=gpt-oss-20b"],
      ["100000.00.000.000", "srv  llama_server: absurd, and still just a field"],
    ] as const;

    for (const [stamp, rest] of widths) {
      const line = parseLogLine(`${stamp} I ${rest}`);
      expect(line.level).toBe("INFO");
      expect(line.message).toBe(rest);
      // A child line wears the same stamp behind the router's port prefix.
      const child = parseLogLine(`[57409] ${stamp} W ${rest}`);
      expect(child.origin).toBe("child");
      expect(child.port).toBe(57409);
      expect(child.level).toBe("WARN");
      expect(child.message).toBe(rest);
    }

    // The fixed-width fields stay fixed: a stamp-shaped thing that is not one
    // is message text, not a stamp to swallow.
    const notAStamp = parseLogLine("1.2.3.4 I srv x");
    expect(notAStamp.message).toBe("1.2.3.4 I srv x");
  });

  it("reads the `[port]` prefix through the space padding the router adds", () => {
    // The router forwards child output as LOG("[%5d] %s", port, buffer), so the
    // port is right-aligned in a five-wide field. A four-digit port therefore
    // arrives with a leading space, and a parser demanding `[\d+]` loses both
    // the child origin and the port that is the line's only attribution.
    const padded = parseLogLine(
      "[ 8080] 12.34.567.890 I slot print_timing: id  0 | task 7 | prompt eval time = 191.34 ms",
    );
    expect(padded.origin).toBe("child");
    expect(padded.port).toBe(8080);
    expect(padded.level).toBe("INFO");
    expect(padded.message).toBe("slot print_timing: id  0 | task 7 | prompt eval time = 191.34 ms");

    // Narrower ports pad wider; the field width itself is not something to rely
    // on, so any amount of padding on either side reads the same.
    for (const prefix of ["[  443]", "[   80]", "[    8]", "[8080 ]", "[ 8080 ]"]) {
      const line = parseLogLine(`${prefix} 0.00.000.001 E srv  llama_server: exiting`);
      expect(line.origin).toBe("child");
      expect(line.level).toBe("ERROR");
      expect(line.message).toBe("srv  llama_server: exiting");
    }

    // Regression: the five-digit ephemeral ports that fill a real corpus, and
    // which are why the padding went unnoticed, are unchanged.
    const ephemeral = parseLogLine(
      "[57409] 1408.02.762.105 I slot print_timing: id  0 | task 81259 | total time = 1064.45 ms",
    );
    expect(ephemeral.origin).toBe("child");
    expect(ephemeral.port).toBe(57409);
    expect(ephemeral.message.startsWith("slot print_timing:")).toBe(true);

    // Padding is spaces and digits only — bracketed message text stays text.
    for (const raw of ["[ warn ] something", "[80a] something", "[] something"]) {
      const line = parseLogLine(raw);
      expect(line.origin).toBe("router");
      expect(line.port).toBeNull();
      expect(line.message).toBe(raw);
    }
  });

  it("reads a router-forwarded line that has neither level nor elapsed stamp", () => {
    // The router forwards with LOG(), which is GGML_LOG_LEVEL_NONE, and the
    // whole prefix block — timestamp AND level letter — is skipped for that
    // level. So the router contributes only `[port] `; whatever framing follows
    // belongs to the child, and there may be none.
    const ipc = parseLogLine(
      '[ 8080] cmd_child_to_router:state:{"state":"ready","payload":{"id":"gpt-oss-20b"}}',
    );
    expect(ipc.origin).toBe("child");
    expect(ipc.port).toBe(8080);
    expect(ipc.level).toBe("INFO");
    expect(ipc.kind).toBe("event");
    expect(ipc.message).toBe(
      'cmd_child_to_router:state:{"state":"ready","payload":{"id":"gpt-oss-20b"}}',
    );

    // A child run with --no-log-prefix forwards bare text, which must not be
    // mined for a stamp or a level that is not there.
    const bare = parseLogLine("[57409] srv  llama_server: model loaded");
    expect(bare.origin).toBe("child");
    expect(bare.port).toBe(57409);
    expect(bare.level).toBe("INFO");
    expect(bare.message).toBe("srv  llama_server: model loaded");

    // Timestamps without the level letter, and the letter without a timestamp,
    // are both reachable (--no-log-prefix gates both, --no-log-timestamps only
    // the stamp), and each field is read on its own.
    const stampOnly = parseLogLine("[57409] 0.00.080.351 cmn  common_param: verbosity = 3");
    expect(stampOnly.level).toBe("INFO");
    expect(stampOnly.message).toBe("cmn  common_param: verbosity = 3");

    const levelOnly = parseLogLine("[ 8080] E gguf_init_from_file: failed to open GGUF file");
    expect(levelOnly.origin).toBe("child");
    expect(levelOnly.port).toBe(8080);
    expect(levelOnly.level).toBe("ERROR");
    expect(levelOnly.message).toBe("gguf_init_from_file: failed to open GGUF file");

    // A forwarded line whose text is empty is still a child line, not a crash.
    const empty = parseLogLine("[ 8080] ");
    expect(empty.origin).toBe("child");
    expect(empty.port).toBe(8080);
    expect(empty.message).toBe("");
  });

  it("keeps the message a verbatim suffix of the raw line, whatever the framing", () => {
    // The invariant the console depends on: parsing removes a prefix and never
    // rewrites anything. Verified across a real corpus; pinned here on the
    // shapes that have prefixes to remove.
    const raws = [
      "1401.19.775.771 I srv  proxy_reques: proxying request to model gpt-oss-20b on port 62354",
      "[57409] 1408.02.762.105 I slot print_timing: id  0 | task 81259 | total time = 1064.45 ms",
      "[ 8080] 180.05.123.456 E gguf_init_from_file: failed to open GGUF file '/m/broken.gguf'",
      '[ 8080] cmd_child_to_router:state:{"state":"loading"}',
      "[57409] srv  llama_server: model loaded",
      "  --ctx-size",
      "0.00.051.592 E llama_model_load: error loading model",
      "]]] {{{ ???",
      "",
    ];
    for (const raw of raws) {
      expect(raw.endsWith(parseLogLine(raw).message)).toBe(true);
    }
  });
});
