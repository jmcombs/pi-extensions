/**
 * Parser tests for the 1Password shell-plugin extractor.
 *
 * Fixtures are in-memory Go snippets matching real upstream idioms
 * (`plugins/npm/access_token.go`). No GitHub tarball is fetched.
 */

import { describe, expect, it } from "vitest";
import { extractEnvVars, pickPrimaryEnvVar } from "./1p-shell-plugins-extract.js";

function sources(src: string): Array<[string, string]> {
  return [["access_token.go", src]];
}

describe("extractEnvVars", () => {
  it("collects importer.TryAllEnvVars string literals", () => {
    const envVars = extractEnvVars(
      sources('importer.TryAllEnvVars(fieldname.Token, "NPM_TOKEN", "NODE_AUTH_TOKEN")'),
    );
    expect(envVars).toEqual(["NODE_AUTH_TOKEN", "NPM_TOKEN"]);
  });

  it("still collects AddEnvVar string literals", () => {
    const envVars = extractEnvVars(sources('out.AddEnvVar("PNPM_CONFIG__AUTH", string(contents))'));
    expect(envVars).toEqual(["PNPM_CONFIG__AUTH"]);
  });

  it("does not invent names from fmt.Sprintf or non-literal AddEnvVar arguments", () => {
    const src = `
			authEnvVar := fmt.Sprintf("npm_config_//%s/:_authToken", registryAuthKey(registry))
			out.AddEnvVar(authEnvVar, in.ItemFields[fieldname.Token])
			registryEnvVar := "npm_config_@" + organization + ":registry"
			out.AddEnvVar(registryEnvVar, registry.String())
			out.AddEnvVar("npm_config_registry", registry.String())
		`;
    expect(extractEnvVars(sources(src))).toEqual([]);
  });

  it("still collects SetPathAsEnvVar string literals", () => {
    const envVars = extractEnvVars(sources('provision.SetPathAsEnvVar("NPM_CONFIG_USERCONFIG")'));
    expect(envVars).toEqual(["NPM_CONFIG_USERCONFIG"]);
  });
});

describe("pickPrimaryEnvVar", () => {
  it("prefers a real npm credential over PNPM_CONFIG__AUTH", () => {
    const envVars = extractEnvVars(
      sources(`
			importer.TryAllEnvVars(fieldname.Token, "NPM_TOKEN", "NODE_AUTH_TOKEN")
			out.AddEnvVar("PNPM_CONFIG__AUTH", string(contents))
		`),
    );
    const primary = pickPrimaryEnvVar(envVars);
    expect(["NPM_TOKEN", "NODE_AUTH_TOKEN"]).toContain(primary);
    expect(primary).not.toBe("PNPM_CONFIG__AUTH");
  });
});
