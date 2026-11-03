/**
 * Token lookup and download-input checks. Token files are real temp files.
 * No Hugging Face and no omlx calls.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findHuggingFaceToken,
  formatBytes,
  MLX_ONLY_ERROR,
  parseDownloadInput,
} from "./huggingface.js";

const directories: string[] = [];
const originalHome = process.env.HOME;

function restoreHome(): void {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
}

afterEach(async () => {
  restoreHome();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omlx-hf-"));
  directories.push(dir);
  return dir;
}

async function writeToken(dir: string, relative: string, contents: string): Promise<string> {
  const path = join(dir, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  return path;
}

describe("findHuggingFaceToken", () => {
  it("prefers a trimmed HF_TOKEN over token files", async () => {
    const dir = await tempDir();
    const tokenPath = await writeToken(dir, "token", "from-file\n");
    const token = await findHuggingFaceToken({
      HF_TOKEN: "  from-env  ",
      HF_TOKEN_PATH: tokenPath,
      HF_HOME: dir,
      XDG_CACHE_HOME: dir,
    });
    expect(token).toBe("from-env");
  });

  it("skips a blank HF_TOKEN and reads HF_TOKEN_PATH", async () => {
    const dir = await tempDir();
    const tokenPath = await writeToken(dir, "elsewhere", "  from-path \n");
    const home = await tempDir();
    await writeToken(home, "token", "from-home\n");
    const token = await findHuggingFaceToken({
      HF_TOKEN: " \t ",
      HF_TOKEN_PATH: tokenPath,
      HF_HOME: home,
      XDG_CACHE_HOME: dir,
    });
    expect(token).toBe("from-path");
  });

  it("skips a whitespace token file and reads HF_HOME/token", async () => {
    const dir = await tempDir();
    const tokenPath = await writeToken(dir, "blank", "  \n\t");
    const home = await tempDir();
    await writeToken(home, "token", "from-home\n");
    const cache = await tempDir();
    await writeToken(cache, "huggingface/token", "from-xdg\n");
    const token = await findHuggingFaceToken({
      HF_TOKEN: "",
      HF_TOKEN_PATH: tokenPath,
      HF_HOME: home,
      XDG_CACHE_HOME: cache,
    });
    expect(token).toBe("from-home");
  });

  it("skips a whitespace HF_HOME token and reads the XDG cache token", async () => {
    const home = await tempDir();
    await writeToken(home, "token", " \n");
    const cache = await tempDir();
    await writeToken(cache, "huggingface/token", "\tfrom-xdg\n");
    const token = await findHuggingFaceToken({
      HF_TOKEN_PATH: join(home, "missing-token-path"),
      HF_HOME: home,
      XDG_CACHE_HOME: cache,
    });
    expect(token).toBe("from-xdg");
  });

  it("falls through to ~/.cache/huggingface/token when earlier sources are blank", async () => {
    const dir = await tempDir();
    const tokenPath = await writeToken(dir, "blank", " ");
    const home = await tempDir();
    await writeToken(home, ".cache/huggingface/token", "from-home\n");
    process.env.HOME = home;
    try {
      const token = await findHuggingFaceToken({
        HF_TOKEN: " ",
        HF_TOKEN_PATH: tokenPath,
        HF_HOME: dir,
        XDG_CACHE_HOME: dir,
      });
      expect(token).toBe("from-home");
    } finally {
      restoreHome();
    }
  });
});

describe("formatBytes", () => {
  it("matches llama.cpp byte labels", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.00 KiB");
    expect(formatBytes(1536)).toBe("1.50 KiB");
    expect(formatBytes(10 * 1024)).toBe("10.0 KiB");
    expect(formatBytes(1024 * 1024)).toBe("1.00 MiB");
    expect(formatBytes(1024 ** 3)).toBe("1.00 GiB");
    expect(formatBytes(1024 ** 4)).toBe("1.00 TiB");
  });
});

describe("parseDownloadInput", () => {
  it("accepts owner/repo", () => {
    expect(parseDownloadInput("mlx-community/Qwen2.5-0.5B-Instruct-4bit")).toEqual({
      repoId: "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
    });
    expect(parseDownloadInput("  owner/repo  ")).toEqual({ repoId: "owner/repo" });
  });

  it("rejects owner/repo:Q4_K_M as MLX-only", () => {
    expect(parseDownloadInput("owner/repo:Q4_K_M")).toEqual({ error: MLX_ONLY_ERROR });
    expect(parseDownloadInput("unsloth/Qwen3-8B-GGUF:Q4_K_M")).toEqual({
      error: "This extension supports MLX models only. GGUF quantizations are not supported.",
    });
  });
});
