import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import { delimiter, join } from "node:path";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { mergeShellEnv, userBashOperationsResult } from "./bash-env.js";

type RecordedEnv = NodeJS.ProcessEnv | undefined;

function recordingCreateLocal(recorded: RecordedEnv[]): () => {
  exec: (
    command: string,
    cwd: string,
    options: { onData: (data: Buffer) => void; env?: NodeJS.ProcessEnv },
  ) => Promise<{ exitCode: number | null }>;
} {
  return () => ({
    exec: async (_command, _cwd, options) => {
      recorded.push(options.env);
      return { exitCode: 0 };
    },
  });
}

describe("bash-env", () => {
  it("mergeShellEnv keeps the pi bin directory on PATH", async () => {
    expect(mergeShellEnv({ PATH: "base-path" }, { PATH: "overlay-path" }).PATH).toBe(
      "overlay-path",
    );

    const recorded: RecordedEnv[] = [];
    const wrapped = userBashOperationsResult(recordingCreateLocal(recorded), () => ({
      PATH: "overlay-path",
    }));
    expect(wrapped).toBeDefined();
    expect(Object.keys(wrapped ?? {})).toEqual(["operations"]);
    expect(typeof wrapped?.operations.exec).toBe("function");

    await wrapped?.operations.exec("true", os.tmpdir(), {
      onData: () => {},
      env: { PATH: "base-path" },
    });
    expect(recorded[0]?.PATH).toBe("overlay-path");

    const tmp = await mkdtemp(join(os.tmpdir(), "1p-bin-"));
    const saved = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tmp;
    try {
      const bin = join(tmp, "bin");
      const processPathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
      expect(processPathEntries.includes(bin)).toBe(false);

      recorded.length = 0;
      const omitted = userBashOperationsResult(recordingCreateLocal(recorded), () => ({}));
      await omitted?.operations.exec("true", os.tmpdir(), { onData: () => {} });
      const env = recorded[0] ?? {};
      const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
      const passedEntries = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
      expect(passedEntries.includes(bin)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = saved;
    }
  });

  it("userBashOperationsResult returns undefined on throw", () => {
    const result = userBashOperationsResult(
      () => {
        throw new Error("createLocal failed");
      },
      () => ({}),
    );
    expect(result).toBeUndefined();
  });

  it("userBashOperationsResult rejects a non-function exec", () => {
    const result = userBashOperationsResult(
      () => ({ exec: "nope" }),
      () => ({}),
    );
    expect(result).toBeUndefined();
  });

  it("wrapped local exec injects the overlay", async () => {
    const wrapped = userBashOperationsResult(
      () => createLocalBashOperations(),
      () => ({ PI_EXT_087_MARKER: "injected-087" }),
    );
    expect(wrapped).toBeDefined();
    const chunks: Buffer[] = [];
    await wrapped?.operations.exec(`printf '%s' "$PI_EXT_087_MARKER"`, os.tmpdir(), {
      onData: (data) => {
        chunks.push(data);
      },
    });
    expect(Buffer.concat(chunks).toString()).toBe("injected-087");
  }, 15000);
});
