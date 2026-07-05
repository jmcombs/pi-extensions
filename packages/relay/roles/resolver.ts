/**
 * roles/resolver.ts — resolve a pi-subagent "role" into the pieces an external
 * coding agent needs: an assembled system prompt (persona body + referenced
 * skills) and a mapped tool allowlist.
 *
 * ── Where the system prompt actually comes from (context vs. resolver) ──
 * pi runs a subagent by spawning a CHILD `pi` process whose system prompt is
 * ALREADY the assembled persona body + skill bodies (pi-subagents does this in
 * `runs/foreground/execution.ts`: `systemPrompt = personaBody + buildSkillInjection(skills)`,
 * then passes it via `--system-prompt`/`--append-system-prompt`). That child pi,
 * running `model: relay-claude/<id>`, hands US that exact text as
 * `context.systemPrompt` in the provider's `streamSimple`. So on the live
 * pi-subagents path the provider RELAYS `context.systemPrompt` verbatim — it does
 * NOT re-resolve by name here (that would double-inject / risk drift).
 *
 * {@link resolveRole} is therefore the seam's *fallback / building block*: it lets
 * a caller that is NOT going through pi-subagents (e.g. the codex driver, or a
 * direct provider invocation with no assembled system prompt) reconstruct the same
 * persona+skills text from disk. {@link mapToolNames} is used on BOTH paths — the
 * live provider maps `context.tools`, and `resolveRole` maps a role's declared
 * `tools`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * pi tool name → external (Claude) tool name. pi-only tools with no external
 * equivalent (e.g. `subagent`) are intentionally absent and get dropped by
 * {@link mapToolNames}. `thinking` / context-inherit fields are N/A here.
 */
export const TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  read: "Read",
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  grep: "Grep",
  glob: "Glob",
};

/** Map a single pi tool name to its external equivalent, or `undefined` if none. */
export function mapToolName(piName: string): string | undefined {
  return TOOL_NAME_MAP[piName.trim().toLowerCase()];
}

/**
 * Map a list of pi tool names to external tool names, dropping pi-only tools with
 * no external equivalent and de-duplicating while preserving order.
 */
export function mapToolNames(piNames: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of piNames) {
    const mapped = mapToolName(name);
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out;
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
  /** Declared pi tool names (unmapped). */
  readonly tools: string[];
  /** External tool names, mapped from {@link tools} via {@link mapToolNames}. */
  readonly allowedTools: string[];
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

/** Read a file, resolving symlinks (agents/skills dirs are symlinked from dotfiles). */
function readResolved(filePath: string): string {
  const real = fs.realpathSync(filePath);
  return fs.readFileSync(real, "utf8");
}

/**
 * Resolve a pi-subagent by name into a {@link ResolvedRole}: read
 * `<agentsDir>/<name>.md`, parse its persona body + frontmatter, read each
 * referenced `<skillsDir>/<skill>/SKILL.md`, and assemble them into ONE
 * system-prompt string. Applies the tool-name map to the declared tools.
 *
 * This mirrors what pi-subagents assembles for the child pi's system prompt, and
 * exists for callers that resolve a role OUTSIDE the pi-subagents path (see the
 * module header). On the live pi-subagents path, prefer relaying
 * `context.systemPrompt` instead of calling this.
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
    allowedTools: mapToolNames(frontmatter.tools),
    systemPromptMode: frontmatter.systemPromptMode,
    ...(frontmatter.model !== undefined ? { model: frontmatter.model } : {}),
  };
}
