/**
 * The tailer's contract, exercised against real temp files — never against the
 * machine's actual `/tmp/llama-router.log`, which belongs to the operator.
 *
 * Every case here is a hazard that was verified to happen on this platform: a
 * router restart that APPENDS (launchd does not truncate, and 16 boots were
 * observed in one file), `com.apple.tmp_cleaner` unlinking a `/tmp` log that
 * went three days untouched, a read landing mid-line, and a producer that writes
 * without newlines. The rules that fall out are: the backlog and the live tail
 * come from one offset, `seq` never goes backwards, and nothing ever throws.
 */

import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LogLine } from "../core/types.js";
import { createFileTailer, DEFAULT_LOG_PATH, LOG_FILE_ENV, resolveLogPath } from "./log-tailer.js";

let dir = "";
let path = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "steward-log-"));
  path = join(dir, "llama-router.log");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A tailer with no timer: the tests drive `poll()` themselves. */
function tail(overrides: { path?: string; backlogBytes?: number; maxLines?: number } = {}) {
  return createFileTailer({
    path: overrides.path ?? path,
    pollIntervalMs: 0,
    now: () => 1_760_000_000_000,
    ...overrides,
  });
}

/** One router line, complete with its elapsed stamp and level. */
function routerLine(message: string): string {
  return `0.00.000.001 I ${message}\n`;
}

describe("createFileTailer", () => {
  it("serves the backlog and the live tail from one offset", () => {
    writeFileSync(
      path,
      [
        routerLine("srv  llama_server: listening on http://127.0.0.1:8080"),
        routerLine("srv  llama_server: model loaded"),
      ].join(""),
    );
    const tailer = tail();
    try {
      const backlog = tailer.recent(100);
      expect(backlog).toHaveLength(2);
      expect(backlog[0]?.message).toBe("srv  llama_server: listening on http://127.0.0.1:8080");
      expect(backlog.map((line) => line.seq)).toEqual([1, 2]);

      const live: LogLine[] = [];
      tailer.subscribe((line) => live.push(line));
      appendFileSync(path, routerLine("srv        unload: stopping model instance name=M"));
      tailer.poll();

      // The seam: the subscriber sees the new line and only the new line, and
      // the buffer holds each line exactly once.
      expect(live.map((line) => line.message)).toEqual([
        "srv        unload: stopping model instance name=M",
      ]);
      expect(tailer.recent(100).map((line) => line.seq)).toEqual([1, 2, 3]);
    } finally {
      tailer.close();
    }
  });

  it("holds a partial trailing line until its newline arrives", () => {
    writeFileSync(path, routerLine("srv  llama_server: model loaded"));
    const tailer = tail();
    try {
      const live: LogLine[] = [];
      tailer.subscribe((line) => live.push(line));

      // A read can land mid-line; a fragment is not a record.
      appendFileSync(path, "0.00.000.002 I srv  proxy_reques: proxying request");
      tailer.poll();
      expect(live).toEqual([]);

      appendFileSync(path, " to model gpt-oss-20b on port 62354\n");
      tailer.poll();
      expect(live).toHaveLength(1);
      expect(live[0]?.message).toBe(
        "srv  proxy_reques: proxying request to model gpt-oss-20b on port 62354",
      );
      expect(live[0]?.kind).toBe("proxy");
    } finally {
      tailer.close();
    }
  });

  it("keeps reading, and keeps numbering, across a service restart", () => {
    // launchd APPENDS across restarts — a restart is not a rotation, and a `seq`
    // that went backwards here would make the client re-adopt its whole buffer.
    writeFileSync(path, routerLine("srv  llama_server: listening on http://127.0.0.1:8080"));
    const tailer = tail();
    try {
      appendFileSync(
        path,
        [
          routerLine("srv    operator(): instance name=gpt-oss-20b exited with status 0"),
          routerLine("cmn  common_param: common_params_print_info: verbosity = 3"),
          routerLine("srv  llama_server: listening on http://127.0.0.1:8080"),
        ].join(""),
      );
      tailer.poll();

      const lines = tailer.recent(100);
      expect(lines.map((line) => line.seq)).toEqual([1, 2, 3, 4]);
      expect(tailer.status().source).toBe("ok");
    } finally {
      tailer.close();
    }
  });

  it("re-reads from the start when the file is truncated in place", () => {
    writeFileSync(path, routerLine("srv  first line"));
    const tailer = tail();
    try {
      expect(tailer.recent(100)).toHaveLength(1);

      truncateSync(path, 0);
      tailer.poll();
      appendFileSync(path, routerLine("srv  after truncation"));
      tailer.poll();

      const lines = tailer.recent(100);
      expect(lines.map((line) => line.message)).toEqual([
        "srv  first line",
        "srv  after truncation",
      ]);
      // Same file, fresh content — but the sequence is the source's lifetime,
      // not the file's.
      expect(lines.map((line) => line.seq)).toEqual([1, 2]);
    } finally {
      tailer.close();
    }
  });

  it("reports an unlinked file as missing, and picks it back up when it returns", () => {
    writeFileSync(path, routerLine("srv  before the cleaner ran"));
    const tailer = tail();
    try {
      expect(tailer.status()).toEqual({ source: "ok", path, detail: null });

      // What `com.apple.tmp_cleaner` does at 00:00 to a /tmp log whose atime,
      // mtime and ctime have all passed three days.
      rmSync(path);
      tailer.poll();
      expect(tailer.status().source).toBe("missing");
      expect(tailer.status().detail).toContain(path);
      // The lines Steward already read stay exactly where they are.
      expect(tailer.recent(100)).toHaveLength(1);

      // Self-healing: the router writes again, the path reappears with a new
      // inode, and the tail resumes from the start of the new file.
      writeFileSync(path, routerLine("srv  llama_server: listening on http://127.0.0.1:8080"));
      tailer.poll();

      const lines = tailer.recent(100);
      expect(lines).toHaveLength(2);
      expect(lines.map((line) => line.seq)).toEqual([1, 2]);
      expect(lines[1]?.message).toBe("srv  llama_server: listening on http://127.0.0.1:8080");
      expect(tailer.status().source).toBe("ok");
    } finally {
      tailer.close();
    }
  });

  it("anchors a replacement file too, rather than flooding every console with it", () => {
    writeFileSync(path, routerLine("srv  the file we were following"));
    const tailer = tail({ backlogBytes: 512 });
    try {
      const live: LogLine[] = [];
      tailer.subscribe((line) => live.push(line));

      // Rotated into — or restored from — a file that already has a history.
      // Following it from byte 0 would push the whole thing at every connected
      // client; the backlog window is the same promise as on first sight.
      rmSync(path);
      writeFileSync(path, routerLine("srv  restored line").repeat(400));
      tailer.poll();

      expect(live.length).toBeGreaterThan(3);
      expect(live.length).toBeLessThan(20);
      expect(live.every((line) => line.message === "srv  restored line")).toBe(true);
    } finally {
      tailer.close();
    }
  });

  it("anchors after a truncation that leaves a still-large file", () => {
    // `copytruncate` on a big log: the file is shorter than our offset — so the
    // shrink is detectable — but still far larger than the backlog window. The
    // old code read the remainder whole; the window is the same promise here as
    // on first sight.
    writeFileSync(path, routerLine("srv  before").repeat(200));
    const tailer = tail({ backlogBytes: 512 });
    try {
      const live: LogLine[] = [];
      tailer.subscribe((line) => live.push(line));

      writeFileSync(path, routerLine("srv  after").repeat(100));
      tailer.poll();

      expect(live.length).toBeGreaterThan(3);
      expect(live.length).toBeLessThan(30);
      expect(live.every((line) => line.message === "srv  after")).toBe(true);
    } finally {
      tailer.close();
    }
  });

  it("hands back the backlog and the subscription in one step", () => {
    writeFileSync(path, routerLine("srv  first").repeat(3));
    const tailer = tail();
    try {
      const live: LogLine[] = [];
      const { backlog, unsubscribe } = tailer.attach((line) => live.push(line), 2);

      // The backlog is a snapshot taken as the listener is registered, so a poll
      // can no longer land between the two and drop a line out of both halves.
      expect(backlog.map((line) => line.seq)).toEqual([2, 3]);
      expect(live).toEqual([]);

      appendFileSync(path, routerLine("srv  second"));
      tailer.poll();
      expect(live.map((line) => line.seq)).toEqual([4]);

      // Together they cover the stream with no gap and no repeat.
      expect([...backlog, ...live].map((line) => line.seq)).toEqual([2, 3, 4]);

      unsubscribe();
      appendFileSync(path, routerLine("srv  third"));
      tailer.poll();
      expect(live).toHaveLength(1);
    } finally {
      tailer.close();
    }
  });

  it("attaches with no backlog when none is asked for", () => {
    writeFileSync(path, routerLine("srv  buffered"));
    const tailer = tail();
    try {
      const live: LogLine[] = [];
      const { backlog } = tailer.attach((line) => live.push(line), 0);
      expect(backlog).toEqual([]);
      appendFileSync(path, routerLine("srv  live"));
      tailer.poll();
      expect(live).toHaveLength(1);
    } finally {
      tailer.close();
    }
  });

  it("merges a port refresh instead of forgetting a spawn it saw first", () => {
    writeFileSync(path, "");
    const tailer = tail();
    try {
      // A child that spawned since the last snapshot is known from its spawn
      // line and not yet from `/models`; the next refresh must not erase it.
      appendFileSync(
        path,
        routerLine("srv          load: spawning server instance with name=fresh on port 53691"),
      );
      tailer.poll();
      tailer.setPorts(new Map([[62354, "older"]]));

      appendFileSync(
        path,
        [
          "[53691] 0.00.000.001 I srv  llama_server: model loaded\n",
          "[62354] 0.00.000.002 I srv  llama_server: model loaded\n",
        ].join(""),
      );
      tailer.poll();

      const recent = tailer.recent(2);
      expect(recent[0]?.modelId).toBe("fresh");
      expect(recent[1]?.modelId).toBe("older");
    } finally {
      tailer.close();
    }
  });

  it("is an honest no-log state when the path has never existed", () => {
    const tailer = tail({ path: join(dir, "not-there.log") });
    try {
      expect(tailer.recent(100)).toEqual([]);
      expect(tailer.status().source).toBe("missing");
      // Polling a path that is not there is not an error, and never throws.
      tailer.poll();
      tailer.poll();
      expect(tailer.status().source).toBe("missing");
    } finally {
      tailer.close();
    }
  });

  it("reports an unreadable path as unavailable rather than missing", () => {
    // A directory exists but is not a log: `stat` succeeds and the read fails,
    // which is the shape of every permission and I/O failure.
    const tailer = tail({ path: dir });
    try {
      expect(tailer.status().source).toBe("unavailable");
      expect(tailer.status().detail).toContain(dir);
      expect(tailer.recent(100)).toEqual([]);
    } finally {
      tailer.close();
    }
  });

  it("drops a newline-less flood instead of buffering it", () => {
    writeFileSync(path, routerLine("srv  before the flood"));
    const tailer = tail();
    try {
      const live: LogLine[] = [];
      tailer.subscribe((line) => live.push(line));

      // 100 KB with no line terminator: past the splitter's cap, so it is
      // discarded and the stream resyncs at the next newline.
      appendFileSync(path, "x".repeat(100 * 1024));
      tailer.poll();
      expect(live).toEqual([]);

      appendFileSync(path, `\n${routerLine("srv  after the flood")}`);
      tailer.poll();
      expect(live.map((line) => line.message)).toEqual(["srv  after the flood"]);
    } finally {
      tailer.close();
    }
  });

  it("reads only a backlog window of an already-huge file, and no half line", () => {
    const filler = routerLine("srv  proxy_reques: proxying request to model M on port 1");
    writeFileSync(path, filler.repeat(400));
    const tailer = tail({ backlogBytes: 512 });
    try {
      const lines = tailer.recent(1000);
      // A months-old log is not read whole …
      expect(lines.length).toBeGreaterThan(3);
      expect(lines.length).toBeLessThan(20);
      // … and the line the window landed in the middle of is never emitted as
      // if it were a record.
      expect(lines.every((line) => line.message.startsWith("srv  proxy_reques:"))).toBe(true);
    } finally {
      tailer.close();
    }
  });

  it("caps what it retains, without dropping anything a subscriber is owed", () => {
    writeFileSync(path, routerLine("srv  seed"));
    const tailer = tail({ maxLines: 5 });
    try {
      const live: LogLine[] = [];
      tailer.subscribe((line) => live.push(line));
      for (let i = 0; i < 20; i += 1) appendFileSync(path, routerLine(`srv  line ${i}`));
      tailer.poll();

      expect(live).toHaveLength(20);
      expect(tailer.recent(100)).toHaveLength(5);
      expect(tailer.recent(100).map((line) => line.seq)).toEqual([17, 18, 19, 20, 21]);
      expect(tailer.recent(0)).toEqual([]);
    } finally {
      tailer.close();
    }
  });

  it("attributes child lines by port, and leaves the rest honestly unattributed", () => {
    writeFileSync(path, "");
    const tailer = tail();
    try {
      // The map Steward builds from `/models` — the log's own mapping line is
      // typically thousands of lines behind the live tail.
      tailer.setPorts(new Map([[62354, "gpt-oss-20b"]]));
      appendFileSync(
        path,
        [
          "[62354] 1408.02.762.124 I slot      release: id  0 | task 81259 | stop processing: n_tokens = 193, truncated = 0\n",
          "[51302] 0.00.261.028 W llama_kv_cache: layer   3: sharing with layer 59\n",
          routerLine("srv  llama_server: NOTE: router mode is experimental"),
        ].join(""),
      );
      tailer.poll();

      const [attributed, unmapped, routerWide] = tailer.recent(10);
      expect(attributed?.modelId).toBe("gpt-oss-20b");
      expect(attributed?.origin).toBe("child");
      // A child whose port Steward has not mapped is genuinely unknown …
      expect(unmapped?.modelId).toBeNull();
      expect(unmapped?.origin).toBe("child");
      // … and a router-wide line is about no model at all. Same null, different
      // meanings, which is exactly why `origin` exists.
      expect(routerWide?.modelId).toBeNull();
      expect(routerWide?.origin).toBe("router");
    } finally {
      tailer.close();
    }
  });

  it("maps a spawn it sees live, before the next /models poll", () => {
    writeFileSync(path, "");
    const tailer = tail();
    try {
      appendFileSync(
        path,
        [
          routerLine(
            "srv          load: spawning server instance with name=new-model on port 53691",
          ),
          "[53691] 0.00.715.177 I srv  llama_server: model loaded\n",
        ].join(""),
      );
      tailer.poll();

      const lines = tailer.recent(10);
      expect(lines[0]?.modelId).toBe("new-model");
      expect(lines[1]?.modelId).toBe("new-model");
    } finally {
      tailer.close();
    }
  });

  it("keeps the last known port map when a /models read comes back empty", () => {
    writeFileSync(path, "");
    const tailer = tail();
    try {
      tailer.setPorts(new Map([[62354, "gpt-oss-20b"]]));
      // A failed or empty `/models` read must not blank out attribution for
      // every child line until the next successful poll.
      tailer.setPorts(new Map());
      appendFileSync(path, "[62354] 0.00.000.001 I srv  llama_server: model loaded\n");
      tailer.poll();

      expect(tailer.recent(10)[0]?.modelId).toBe("gpt-oss-20b");
    } finally {
      tailer.close();
    }
  });

  it("stops polling and stops delivering once it is closed", () => {
    writeFileSync(path, routerLine("srv  seed"));
    const tailer = tail();
    const live: LogLine[] = [];
    tailer.subscribe((line) => live.push(line));
    tailer.close();

    appendFileSync(path, routerLine("srv  after close"));
    tailer.poll();
    expect(live).toEqual([]);
    expect(tailer.recent(10)).toHaveLength(1);
  });

  it("does the polling itself when it is given an interval", async () => {
    writeFileSync(path, routerLine("srv  seed"));
    const tailer = createFileTailer({ path, pollIntervalMs: 10 });
    try {
      const live: LogLine[] = [];
      tailer.subscribe((line) => live.push(line));
      appendFileSync(path, routerLine("srv  appended"));

      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(live.map((line) => line.message)).toEqual(["srv  appended"]);
    } finally {
      tailer.close();
    }
  });
});

describe("resolveLogPath", () => {
  it("prefers the environment override, even when the file is not there yet", () => {
    const resolved = resolveLogPath({
      env: { [LOG_FILE_ENV]: " /var/log/llama.log " },
      config: { path: "/from/config.log" },
      exists: () => false,
    });
    expect(resolved).toBe("/var/log/llama.log");
  });

  it("falls back to the recorded config path", () => {
    const resolved = resolveLogPath({
      env: {},
      config: { path: "/from/config.log" },
      exists: () => false,
    });
    // Taken at its word: the operator (or the skill) named it, and a named path
    // that is missing right now is a state worth showing — and one that heals.
    expect(resolved).toBe("/from/config.log");
  });

  it("adopts the platform convention only when the file is really there", () => {
    expect(resolveLogPath({ env: {}, config: null, exists: () => true })).toBe(DEFAULT_LOG_PATH);
    // Nothing configured and nothing there: an honest "no log source", rather
    // than blaming a /tmp path nobody chose.
    expect(resolveLogPath({ env: {}, config: null, exists: () => false })).toBeNull();
    expect(
      resolveLogPath({ env: { [LOG_FILE_ENV]: "  " }, config: null, exists: () => false }),
    ).toBeNull();
  });
});
