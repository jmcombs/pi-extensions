import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  hostMarkerLine,
  loadHostCompat,
  parseHostCompat,
  partitionForHost,
  readmeMarkerErrors,
  rootHostCells,
  rootTableErrors,
  validateHostRun,
} from "./host-compat.mjs";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "host-compat-"));
  roots.push(root);
  return root;
}

function writePackage(root: string, dir: string, pkg: Record<string, unknown>): void {
  const packageDir = path.join(root, "packages", dir);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(path.join(packageDir, "package.json"), JSON.stringify(pkg));
}

function writeExceptions(root: string, value: unknown): void {
  writeFileSync(path.join(root, "extension-host-exceptions.json"), JSON.stringify(value));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("parseHostCompat", () => {
  it("rejects both hosts", () => {
    const result = parseHostCompat({
      hosts: ["pi", "oh-my-pi"],
      exceptions: [
        {
          package: "omlx",
          incompatible: ["pi", "oh-my-pi"],
          reason: "pi and oh-my-pi both lack the API",
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("exactly one");
  });

  it("rejects a hosts value that is not the pinned pair", () => {
    const result = parseHostCompat({
      hosts: ["pi", "omp"],
      exceptions: [],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a missing reason", () => {
    const result = parseHostCompat({
      hosts: ["pi", "oh-my-pi"],
      exceptions: [{ package: "omlx", incompatible: ["oh-my-pi"] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("reason");
  });
});

describe("loadHostCompat", () => {
  it("fails closed when the file is missing", () => {
    const result = loadHostCompat(tempRoot());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("missing");
  });

  it("fails closed on invalid JSON", () => {
    const root = tempRoot();
    writeFileSync(path.join(root, "extension-host-exceptions.json"), "{");
    const result = loadHostCompat(root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("not valid JSON");
  });

  it("fails on an unknown package", () => {
    const root = tempRoot();
    writeExceptions(root, {
      hosts: ["pi", "oh-my-pi"],
      exceptions: [
        {
          package: "missing",
          incompatible: ["oh-my-pi"],
          reason: "oh-my-pi has no such package",
        },
      ],
    });
    const result = loadHostCompat(root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("unknown package");
  });

  it("rejects an exception that names _template even when that package could otherwise load", () => {
    const root = tempRoot();
    writePackage(root, "_template", {
      name: "@jmcombs/pi-EXTENSION_NAME",
      private: false,
      pi: { extensions: ["./index.ts"] },
    });
    writeExceptions(root, {
      hosts: ["pi", "oh-my-pi"],
      exceptions: [
        {
          package: "_template",
          incompatible: ["pi"],
          reason: "pi cannot load the template",
        },
      ],
    });
    const result = loadHostCompat(root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("_template");
  });

  it("loads the repo exception list", () => {
    const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
    const result = loadHostCompat(repoRoot);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.exceptions.map((entry) => entry.package)).toEqual(["omlx"]);
      expect(result.exceptions[0]?.incompatible).toEqual(["oh-my-pi"]);
    }
  });
});

describe("partitionForHost", () => {
  const packages = [
    { dir: "omlx", name: "@jmcombs/pi-omlx", paths: ["/packages/omlx/index.ts"] },
    { dir: "notify", name: "@jmcombs/pi-notify", paths: ["/packages/notify/index.ts"] },
  ];
  const exceptions = [
    {
      package: "omlx",
      incompatible: ["oh-my-pi"],
      reason: "oh-my-pi cannot host the provider",
    },
  ];

  it("skips only the listed pair and still runs that package on the other host", () => {
    const omp = partitionForHost(packages, "oh-my-pi", exceptions);
    expect(omp.run.map((pkg) => pkg.dir)).toEqual(["notify"]);
    expect(omp.hostSkipped.map((pkg) => pkg.dir)).toEqual(["omlx"]);
    const pi = partitionForHost(packages, "pi", exceptions);
    expect(pi.run.map((pkg) => pkg.dir)).toEqual(["omlx", "notify"]);
    expect(pi.hostSkipped).toEqual([]);
  });

  it("fails an empty run", () => {
    const result = validateHostRun([]);
    expect(result.ok).toBe(false);
  });
});

describe("readme marks", () => {
  it("requires the marker on the line after the blank line that follows the H1", () => {
    const expected = hostMarkerLine("notify", []);
    const text = `# @jmcombs/pi-notify\n\n${expected}\n\nBody\n`;
    expect(readmeMarkerErrors(text, expected)).toEqual([]);
    expect(readmeMarkerErrors(`# Title\n\nBody\n`, expected).length).toBeGreaterThan(0);
  });

  it("builds the omlx mark and the root row from the exception", () => {
    const exceptions = [
      { package: "omlx", incompatible: ["oh-my-pi"], reason: "oh-my-pi cannot load it" },
    ];
    expect(hostMarkerLine("omlx", exceptions)).toBe("**Hosts:** pi \u2713 · oh-my-pi \u2717");
    expect(rootHostCells("@jmcombs/pi-agent-files", "agent-files", [], true)).toEqual([
      "`@jmcombs/pi-agent-files` (library)",
      "\u2713",
      "\u2713",
    ]);
    const row = rootHostCells("@jmcombs/pi-omlx", "omlx", exceptions, false);
    const readme = `## Host compatibility\n\n| Package | pi | oh-my-pi |\n| --- | --- | --- |\n| ${row.join(" | ")} |\n\n## Next\n`;
    expect(rootTableErrors(readme, [row])).toEqual([]);
    expect(rootTableErrors(readme, [[...row, "extra"]]).join(" ")).toContain("row 1");
  });
});
