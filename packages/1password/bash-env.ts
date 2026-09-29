/**
 * Shell env merge + fail-closed user_bash operations wrapper.
 *
 * `executeBashWithOperations` does not pass `env`. When the caller omits it,
 * rebuild pi's shell base from public `getAgentDir()` (feature-detected) at
 * call time, then overlay 1Password-injected vars. Never return an invalid
 * `{ operations }` / `{ result }` object; `undefined` means continue.
 */

import { delimiter, join } from "node:path";
import * as piRuntime from "@earendil-works/pi-coding-agent";

export function mergeShellEnv(
  base: NodeJS.ProcessEnv,
  overlay: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return { ...base, ...overlay };
}

function rebuildShellEnv(): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  if (typeof piRuntime.getAgentDir !== "function") {
    return base;
  }
  const binDir = join(piRuntime.getAgentDir(), "bin");
  const pathKey = Object.keys(base).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = base[pathKey] ?? "";
  const pathEntries = currentPath.split(delimiter).filter(Boolean);
  if (!pathEntries.includes(binDir)) {
    base[pathKey] = [binDir, currentPath].filter(Boolean).join(delimiter);
  }
  return base;
}

type ExecOptions = {
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
};

type ExecFn = (
  command: string,
  cwd: string,
  options: ExecOptions,
) => Promise<{ exitCode: number | null }>;

export type UserBashOperationsResult = {
  operations: { exec: ExecFn };
};

export function userBashOperationsResult(
  createLocal: () => unknown,
  overlay: () => NodeJS.ProcessEnv,
): UserBashOperationsResult | undefined {
  try {
    const created: unknown = createLocal();
    if (typeof created !== "object" || created === null) {
      return undefined;
    }
    if (!("exec" in created) || typeof created.exec !== "function") {
      return undefined;
    }
    const innerExec = created.exec as ExecFn;
    const exec: ExecFn = async (command, cwd, options) => {
      const base = options.env === undefined ? rebuildShellEnv() : options.env;
      return innerExec(command, cwd, {
        onData: options.onData,
        signal: options.signal,
        timeout: options.timeout,
        env: mergeShellEnv(base, overlay()),
      });
    };
    return { operations: { exec } };
  } catch {
    return undefined;
  }
}
