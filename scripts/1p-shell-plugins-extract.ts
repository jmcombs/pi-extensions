/**
 * Pure Go-source extractors used by `scripts/update-1p-shell-plugins.ts`.
 *
 * Kept in a separate module so Vitest can import them without running the
 * updater's network fetch of the upstream tarball.
 */

const ENV_VAR_RE = /^[A-Z][A-Z0-9_]{2,}$/;

/**
 * Collect the map keys of a `map[string]sdk.FieldName{...}` literal starting at
 * `from`, by walking to its matching brace so sibling literals aren't swept in.
 */
function collectMapKeys(src: string, from: number, into: Set<string>): void {
  const open = src.indexOf("{", from);
  if (open === -1) return;

  let depth = 0;
  let end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  for (const m of src.slice(open, end).matchAll(/"([^"]+)"\s*:/g)) {
    if (ENV_VAR_RE.test(m[1])) into.add(m[1]);
  }
}

/**
 * Extract every environment variable a plugin injects, across the provisioner
 * idioms the SDK exposes plus importer helpers that take env-var name literals.
 * Test files are excluded by the caller — their fixtures are full of env-var
 * literals that would otherwise be picked up as real mappings.
 */
export function extractEnvVars(sources: Array<[string, string]>): string[] {
  const envVars = new Set<string>();

  for (const [, src] of sources) {
    // 1. provision.EnvVars(map[string]sdk.FieldName{"KEY": ...})
    for (const m of src.matchAll(/provision\.EnvVars\(\s*map\[string\]sdk\.FieldName\s*\{/g)) {
      collectMapKeys(src, m.index + m[0].length - 1, envVars);
    }

    // 2. provision.EnvVars(someMapping) → resolve the package-level var it names.
    for (const m of src.matchAll(/provision\.EnvVars\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g)) {
      const varName = m[1];
      for (const [, other] of sources) {
        const decl = other.search(
          new RegExp(`\\b${varName}\\s*=\\s*map\\[string\\]sdk\\.FieldName\\s*\\{`),
        );
        if (decl !== -1) collectMapKeys(other, decl, envVars);
      }
    }

    // 3. out.AddEnvVar("KEY", ...) inside custom provisioners.
    for (const m of src.matchAll(/AddEnvVar\(\s*"([^"]+)"/g)) {
      if (ENV_VAR_RE.test(m[1])) envVars.add(m[1]);
    }

    // 4. provision.SetPathAsEnvVar("KEY") for config-file-based plugins.
    for (const m of src.matchAll(/SetPathAsEnvVar\(\s*"([^"]+)"/g)) {
      if (ENV_VAR_RE.test(m[1])) envVars.add(m[1]);
    }

    // 5. Provisioner constructors taking env var names as literal args,
    //    e.g. PyPIToolProvisioner("TWINE_USERNAME", "TWINE_PASSWORD").
    for (const m of src.matchAll(/[A-Za-z0-9_]*Provisioner\(([^)]*)\)/g)) {
      for (const lit of m[1].matchAll(/"([^"]+)"/g)) {
        if (ENV_VAR_RE.test(lit[1])) envVars.add(lit[1]);
      }
    }

    // 6. importer.TryAllEnvVars(field, "KEY", ...) and the same family of
    //    helpers that pass env-var name literals as positional string args.
    //    TryEnvVarPair maps are aliases of provisioner keys and are left to
    //    idioms 1–5 — collecting them would let alphabetical rank promote
    //    importer-only spellings (e.g. AMAZON_ACCESS_KEY_ID over AWS_ACCESS_KEY_ID).
    //    Only quoted strings matching ENV_VAR_RE; do not invent fmt.Sprintf names.
    for (const m of src.matchAll(/importer\.Try(?:All)?EnvVars?\(([^)]*)\)/g)) {
      for (const lit of m[1].matchAll(/"([^"]+)"/g)) {
        if (ENV_VAR_RE.test(lit[1])) envVars.add(lit[1]);
      }
    }
  }

  return Array.from(envVars).sort();
}

/** Names that carry the actual secret. `PWD`/`PASSWD` are common abbreviations. */
const CREDENTIAL_RE = /TOKEN|KEY|SECRET|PASSWORD|PASSWD|PWD|AUTH/i;

/** Connection and identity settings that accompany a credential but aren't one. */
const INCIDENTAL_RE =
  /_(HOST|REGION|PROFILE|SERVER|URL|USER|USERNAME|ORG|ORG_ID|PROJECT|ACCOUNT|ENDPOINT|EMAIL|DATABASE|PORT|ZONE)$/i;

/** Deployment-specific variants that shouldn't be the default recommendation. */
const VARIANT_RE = /ENTERPRISE/i;

/**
 * Choose the variable to recommend during onboarding — it gets written into the
 * agent's auth.json as the default, so picking an incidental setting (or a
 * self-hosted variant) sends users down the wrong path.
 *
 * Ranking beats find-first because several plugins expose multiple credentials
 * whose alphabetical order is misleading: GitHub lists GH_ENTERPRISE_TOKEN before
 * GH_TOKEN, and Snowflake lists SNOWSQL_ACCOUNT before SNOWSQL_PWD.
 */
export function pickPrimaryEnvVar(envVars: string[]): string | null {
  if (envVars.length === 0) return null;

  const rank = (v: string): number => {
    if (INCIDENTAL_RE.test(v)) return 3;
    if (!CREDENTIAL_RE.test(v)) return 2;
    return VARIANT_RE.test(v) ? 1 : 0;
  };

  // envVars is already sorted, so equal ranks keep a stable alphabetical order.
  return [...envVars].sort((a, b) => rank(a) - rank(b))[0];
}
