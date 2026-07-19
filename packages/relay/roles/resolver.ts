/**
 * roles/resolver.ts — resolve a pi-subagent "role" into the pieces an external
 * coding agent needs. This module is **backend-neutral** (D10): it emits pi's
 * own tool names and pi-shaped system-prompt text; translating those into a
 * specific agent's flags (e.g. `read` → `Read`, `--allowedTools`) is the
 * DRIVER's job — see `drivers/claude.ts` for the tool-name map.
 *
 * ── Where the system prompt actually comes from (context vs. resolver) ──
 * pi runs a subagent by spawning a CHILD `pi` process whose system prompt is
 * ALREADY the assembled persona body + skill injection (pi-subagents does this in
 * `runs/foreground/execution.ts`: `systemPrompt = personaBody + buildSkillInjection(skills)`,
 * then passes it via `--system-prompt`/`--append-system-prompt`). That child pi,
 * running `model: relay-claude/<id>`, hands US that exact text as
 * `context.systemPrompt` in the provider's `streamSimple`.
 *
 * ── Skill FIDELITY: references → inlined content ({@link expandSkillReferences}) ──
 * pi's `buildSkillInjection` injects skills as an `<available_skills>` block of
 * *references* — `<name>`/`<description>`/`<location>` (the path to `SKILL.md`) —
 * expecting the model to `Read` the file on demand. Relayed to a headless
 * `claude -p`, the external agent may never load that file, so the methodology
 * (e.g. the verifier's phase-verify skill) can go missing. There is NO pi public
 * API that expands a skill reference to its full body (the exported skills API —
 * `loadSkills`/`formatSkillsForPrompt`/`Skill` — only surfaces name/description/
 * filePath), so per D11 we read the referenced `SKILL.md` files ourselves and
 * inline their full content into the system prompt before relaying it.
 *
 * {@link resolveRole} is the seam's *fallback / building block*: it lets a caller
 * that is NOT going through pi-subagents (e.g. the codex driver, or a direct
 * provider invocation with no assembled system prompt) reconstruct the same
 * persona+skills text from disk.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Reverse pi's `escapeXmlText` (used by `buildSkillInjection` on `<location>`). */
function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Read a file, resolving symlinks (agents/skills dirs are symlinked from dotfiles). */
function readResolved(filePath: string): string {
  const real = fs.realpathSync(filePath);
  return fs.readFileSync(real, "utf8");
}

/** Options for {@link expandSkillReferences} — the reader is overridable for testing. */
export interface ExpandSkillOptions {
  /** Read a referenced `SKILL.md` by absolute path. Default resolves symlinks + reads UTF-8. */
  readFile?: (absolutePath: string) => string;
}

/**
 * Normalize a provider `context.systemPrompt` to a single string.
 *
 * pi's public `Context.systemPrompt` type (`@earendil-works/pi-ai`) is
 * `string | undefined`, and real pi (0.80.9) passes a single **string**.
 * **oh-my-pi diverges**: its runtime assembles the system prompt as a
 * **`string[]`** of sections (its own `systemPrompt: string[]`), so calling
 * `.trim()` / feeding it straight into {@link expandSkillReferences} throws
 * (`… .trim is not a function`) under omp. We normalize both shapes here — without
 * lossily `String(obj)`-ing an object into `"[object Object]"` — so relay's live
 * dispatch works on either runtime:
 *
 * - `string`          → returned unchanged (pi).
 * - `string[]`        → its string sections joined with a blank line (omp); this
 *   matches omp's own section separator and loses no content.
 * - `undefined` / any other shape → `""` (no system prompt; the backend runs with
 *   its own default — never a corrupted `"[object Object]"`).
 */
export function normalizeSystemPrompt(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.filter((part): part is string => typeof part === "string").join("\n\n");
  }
  return "";
}

/**
 * Inline the full body of every skill referenced in a pi `<available_skills>`
 * block into the system prompt, so the relayed external agent is GUARANTEED to
 * have each skill's methodology present (fidelity fix) instead of only a
 * `<location>` pointer it might never `Read`.
 *
 * The original `<available_skills>` references are preserved (they carry the
 * `<location>` paths the agent may still use for relative-path resolution); a new
 * `<skill_contents>` section carrying each skill's full `SKILL.md` body is
 * appended. If `systemPrompt` has no `<available_skills>` block (or no readable
 * skills), the normalized prompt string is returned unchanged.
 *
 * Accepts pi's `string | undefined` **and** oh-my-pi's `string[]` runtime shape
 * (normalized via {@link normalizeSystemPrompt}); always returns a string.
 */
export function expandSkillReferences(
  systemPrompt: string | readonly string[] | undefined,
  options: ExpandSkillOptions = {},
): string {
  const prompt = normalizeSystemPrompt(systemPrompt);
  const blockMatch = /<available_skills>([\s\S]*?)<\/available_skills>/.exec(prompt);
  if (!blockMatch) return prompt;

  const read = options.readFile ?? readResolved;
  const block = blockMatch[1] ?? "";
  const skillRe = /<skill>([\s\S]*?)<\/skill>/g;

  const sections: string[] = [];
  for (let m = skillRe.exec(block); m !== null; m = skillRe.exec(block)) {
    const entry = m[1] ?? "";
    const name = unescapeXml(/<name>([\s\S]*?)<\/name>/.exec(entry)?.[1]?.trim() ?? "");
    const location = unescapeXml(/<location>([\s\S]*?)<\/location>/.exec(entry)?.[1]?.trim() ?? "");
    if (location.length === 0) continue;

    let body: string;
    try {
      body = read(location).trim();
    } catch (error) {
      // Fidelity is best-effort: a skill we cannot read is left as its reference
      // rather than aborting the whole relay run. Note it inline so it is visible.
      const message = error instanceof Error ? error.message : String(error);
      sections.push(`### Skill: ${name || location} (could not inline: ${message})`);
      continue;
    }
    sections.push(`### Skill: ${name || location}\n\n(inlined from ${location})\n\n${body}`);
  }

  if (sections.length === 0) return prompt;

  const inlined = [
    "<skill_contents>",
    "The full content of each configured skill is inlined below so it is always",
    "present without a separate read. Treat these as authoritative instructions.",
    "",
    sections.join("\n\n"),
    "</skill_contents>",
  ].join("\n");

  return `${prompt.trimEnd()}\n\n${inlined}\n`;
}

/** Frontmatter fields the resolver understands (a subset of the pi subagent schema). */
interface RoleFrontmatter {
  skills: string[];
  tools: string[];
  systemPromptMode: "replace" | "append";
  model?: string;
}

/** A resolved role, ready to be adapted into a driver invocation. */
export interface ResolvedRole {
  /** The role/subagent name. */
  readonly name: string;
  /** Persona body + skill bodies, assembled into one system-prompt string. */
  readonly systemPrompt: string;
  /** Skill names referenced by the persona (in declaration order). */
  readonly skills: string[];
  /**
   * Declared pi tool names (backend-NEUTRAL). Mapping these onto a specific
   * agent's flags (e.g. `read` → `Read`) is the driver's job (D10).
   */
  readonly tools: string[];
  /** Whether the assembled prompt replaces or appends to the default. */
  readonly systemPromptMode: "replace" | "append";
  /** Declared model id (e.g. `relay-claude/opus`), if any. */
  readonly model?: string;
}

/** Options for {@link resolveRole} — overridable for testing. */
export interface ResolveRoleOptions {
  /** Directory holding `<name>.md` persona files. Default `~/.pi/agent/agents`. */
  agentsDir?: string;
  /** Directory holding `<skill>/SKILL.md` files. Default `~/.pi/agent/skills`. */
  skillsDir?: string;
}

function defaultAgentsDir(): string {
  return path.join(os.homedir(), ".pi", "agent", "agents");
}

function defaultSkillsDir(): string {
  return path.join(os.homedir(), ".pi", "agent", "skills");
}

/** Split a `key: a, b, c` frontmatter list into trimmed, non-empty entries. */
function parseList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Parse the leading `--- … ---` YAML-ish frontmatter block. Only the flat scalar
 * and comma-list fields this seam needs are read; everything else is ignored.
 * Returns the parsed fields plus the persona body (content after the block).
 */
export function parseRoleFile(content: string): {
  frontmatter: RoleFrontmatter;
  body: string;
} {
  const frontmatter: RoleFrontmatter = {
    skills: [],
    tools: [],
    systemPromptMode: "replace",
  };

  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  let body = content;
  if (match) {
    body = content.slice(match[0].length);
    const block = match[1] ?? "";
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trim();
      const sep = line.indexOf(":");
      if (line.length === 0 || sep === -1) continue;
      const key = line.slice(0, sep).trim().toLowerCase();
      const value = line.slice(sep + 1).trim();
      if (key === "skills" || key === "skill") {
        frontmatter.skills = parseList(value);
      } else if (key === "tools" || key === "tool") {
        frontmatter.tools = parseList(value);
      } else if (key === "systempromptmode") {
        frontmatter.systemPromptMode = value === "append" ? "append" : "replace";
      } else if (key === "model") {
        frontmatter.model = value;
      }
    }
  }

  return { frontmatter, body: body.trim() };
}

/**
 * Resolve a pi-subagent by name into a {@link ResolvedRole}: read
 * `<agentsDir>/<name>.md`, parse its persona body + frontmatter, read each
 * referenced `<skillsDir>/<skill>/SKILL.md`, and assemble them into ONE
 * system-prompt string with the skill bodies inlined in full.
 *
 * This mirrors what pi-subagents assembles for the child pi's system prompt (but
 * with FULL skill bodies, not references), and exists for callers that resolve a
 * role OUTSIDE the pi-subagents path (see the module header). On the live
 * pi-subagents path, prefer {@link expandSkillReferences} on `context.systemPrompt`.
 * The returned {@link ResolvedRole.tools} are pi-neutral — the driver maps them.
 */
export function resolveRole(name: string, options: ResolveRoleOptions = {}): ResolvedRole {
  const agentsDir = options.agentsDir ?? defaultAgentsDir();
  const skillsDir = options.skillsDir ?? defaultSkillsDir();

  const personaPath = path.join(agentsDir, `${name}.md`);
  const raw = readResolved(personaPath);
  const { frontmatter, body } = parseRoleFile(raw);

  const sections: string[] = [];
  if (body.length > 0) sections.push(body);

  for (const skill of frontmatter.skills) {
    const skillPath = path.join(skillsDir, skill, "SKILL.md");
    let skillBody: string;
    try {
      skillBody = readResolved(skillPath).trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Role "${name}": skill "${skill}" could not be read (${skillPath}): ${message}`,
      );
    }
    sections.push(`## Skill: ${skill}\n\n${skillBody}`);
  }

  return {
    name,
    systemPrompt: sections.join("\n\n"),
    skills: frontmatter.skills,
    tools: frontmatter.tools,
    systemPromptMode: frontmatter.systemPromptMode,
    ...(frontmatter.model !== undefined ? { model: frontmatter.model } : {}),
  };
}
