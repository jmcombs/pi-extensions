/**
 * Unit tests for the acceptance classifier.
 *
 * Pure synthetic strings — no network, no `pi`, no model. The traps at the
 * bottom are the ones that made earlier validator designs unusable: control
 * tokens inlined from a real fixture file, and a rewrite that is byte-equal to
 * its original because the system prompt asked for exactly that.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyEnhancement, looksLikeHostFailure } from "./classify.js";

/** The fixtures the acceptance matrix actually sends, read from disk. */
const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const KNOWN_PATHS = [
  "packages/prompt-enhancer/index.ts",
  "packages/steward/core/__fixtures__/llama/slots-busy.json",
  "release-please-config.json",
];

function classify(overrides: {
  original?: string;
  enhanced: string;
  stopReason?: string;
  knownPaths?: readonly string[];
  setEditorTextCount?: number;
}) {
  return classifyEnhancement({
    original: overrides.original ?? "fix the typo in the readme",
    enhanced: overrides.enhanced,
    stopReason: overrides.stopReason ?? "stop",
    knownPaths: overrides.knownPaths ?? KNOWN_PATHS,
    setEditorTextCount: overrides.setEditorTextCount ?? 2,
  });
}

describe("classifyEnhancement — announcement", () => {
  it("flags first-person plan narration", () => {
    for (const opener of [
      "I'll inspect the repo first.",
      "I will check the workflow files.",
      "Let me look at the release config.",
      "I'm going to read the package manifests.",
      "I am going to review the alerts.",
      "First, I'll enumerate the packages.",
      "I need to check which packages are affected.",
      "I need to inspect the lockfile.",
      "I need to look at the dependabot config.",
    ]) {
      const result = classify({ enhanced: opener });
      expect(result.verdict, opener).toBe("bad");
      expect(result.codes, opener).toContain("announcement");
    }
  });

  it("flags the verbatim incident output", () => {
    const result = classify({
      enhanced:
        "I'll inspect the repo for security-exception and release-please setup so the rewritten prompt can point at the real files. I'll keep this to discovery only — not answering the original questions.",
    });
    expect(result.verdict).toBe("bad");
    expect(result.codes).toContain("announcement");
  });

  it("does not flag a rewrite that merely quotes first-person text mid-sentence", () => {
    const result = classify({
      original:
        'the SYSTEM_PROMPT in packages/prompt-enhancer/index.ts says not to answer the request but the model still writes "I\'ll inspect the repo" — find where that instruction is contradicted',
      enhanced:
        'In packages/prompt-enhancer/index.ts, locate where SYSTEM_PROMPT forbids answering the request, then identify the instruction that contradicts it and lets the model emit "I\'ll inspect the repo" instead of a rewrite.',
    });
    expect(result.verdict).toBe("good");
    expect(result.codes).toEqual([]);
  });
});

/**
 * The position-0 opener rule scored all fifteen of these `good` in the recorded
 * baseline. Every one is the incident failure mode with the narration starting
 * one clause late, so they are kept verbatim: a rule that stops catching them
 * turns Phase 2's "0 bad in every cell" into a false pass.
 */
const BASELINE_ANNOUNCEMENT_MISSES = [
  "Gathering Dependabot, release-please, and dependency layout so the rewrite stays anchored to this repo. I'll inspect config and package structure without solving the request.",
  "Checking Dependabot and release-please setup so the rewrite can reference the real paths. I'll only inspect config, not answer the question.",
  "Checking the modified README and git diff so the rewrite can point at the actual file.",
  "The request is vague about which README and typo, so I'll inspect the prompt-enhancer files already touched on this branch.",
  "The only modified README is the prompt-enhancer acceptance one — I'll inspect that file so the rewrite can name the typo and path.",
  "Checking the modified README for the typo so the rewrite can point at the right file.",
  "The current branch and modified files point at prompt-enhancer; I'll inspect the README that's already dirty so the rewrite can name the typo and path.",
  "The modified README is the likely target. I'll inspect it and nearby docs so the rewrite can name the exact typo and path.",
  "I need more of the steward slot-parser code and how that fixture is used so the rewrite can point at the real files. I'll look those up next.",
  "I need more of the steward slot-parser code so the rewrite can name the real files and busy-check logic. I'll inspect those paths next.",
  "I need more of the steward slot-parser code and related fixtures so the rewrite can point at the real files. I'll inspect those next.",
  "I need the rest of `SYSTEM_PROMPT` and any other rewriter instructions so the rewrite can point at the real contradiction. I'll inspect the prompt-enhancer sources and the in-progress acceptance/plan files.",
  "I need more of the prompt-enhancer sources and related plan/acceptance files so the rewrite can point at the actual contradiction sites. I'll inspect those next.",
  "I need more of the prompt-enhancer source and related acceptance docs so the rewrite can point at the real contradiction. I'll read the SYSTEM_PROMPT remainder and the files already touched on this branch.",
  "Gathering prompt-enhancer files so the rewrite can point at the real instruction sites. I'll read the system prompt and related docs without solving the bug.",
];

/**
 * The other half of the same corpus: real responses to `self-referential.txt`,
 * which asks about a model that writes `"I'll inspect the repo"`. A faithful
 * rewrite quotes that phrase back, so these are the false-positive probe. All
 * of them were correctly `good` under the old rule and must stay `good`.
 */
const LEGITIMATE_QUOTING_REWRITES = [
  'Find where the prompt-enhancer rewriter is told (or allowed) to produce action/preamble text like "I\'ll inspect the repo", contradicting SYSTEM_PROMPT in packages/prompt-enhancer/index.ts.\n\nSYSTEM_PROMPT already says: do not answer or carry out the request; output only the rewritten prompt; no preamble/commentary; if you catch yourself answering or listing steps, stop and output the rewritten request instead. The model still emits first-person inspection/action openers.\n\nSearch for the contradiction in the actual instruction path, not just SYSTEM_PROMPT itself:\n- packages/prompt-enhancer/index.ts — user-message / context template, any extra system or follow-up text sent with complete(), and how the rewriter output is parsed or passed through\n- packages/prompt-enhancer/acceptance/classify.ts, classify.test.ts, run-matrix.ts, and acceptance/README.md — labels, examples, or scoring that treat action/preamble text as acceptable\n- docs/prompt-enhancer/PLAN.md and docs/prompt-enhancer/baseline.json — sample outputs or guidance that model the bad behavior\n\nReport the contradicting instruction(s) with file path and the conflicting wording. Do not change behavior unless the contradiction is identified.',
  "The SYSTEM_PROMPT in packages/prompt-enhancer/index.ts tells the rewriter not to answer, solve, implement, or carry out the user's request — only rewrite it — but the model still emits preambles like \"I'll inspect the repo\". Find where that instruction is contradicted: search prompt/message construction in packages/prompt-enhancer (SYSTEM_PROMPT and the user/system messages built around it, any secondary prompts, few-shots, or leaked preamble text) and related copy in packages/prompt-enhancer/acceptance/ and docs/prompt-enhancer/. Identify the contradicting site(s).",
  'Inspect packages/prompt-enhancer/index.ts to identify where the SYSTEM_PROMPT instruction "do not answer the user\'s request" is being contradicted by model outputs that include action phrases like "I\'ll inspect the repo" or similar first-person commitments to execute work. Determine whether the contradiction occurs in the prompt text itself, in how the prompt is being sent to the model, or in post-processing of the model\'s response.',
  "Analyze the SYSTEM_PROMPT constant in packages/prompt-enhancer/index.ts to find any instruction, example, or structural pattern that overrides or contradicts the explicit directive against answering the user's request. Identify the exact lines in the template that could lead the model to output meta-commentary such as \"I'll inspect the repo\" instead of strictly providing the rewritten prompt.",
];

const SELF_REFERENTIAL_ORIGINAL =
  'the SYSTEM_PROMPT in packages/prompt-enhancer/index.ts says not to answer the request but the model still writes "I\'ll inspect the repo" — find where that instruction is contradicted';

const SELF_REFERENTIAL_KNOWN_PATHS = [
  ...KNOWN_PATHS,
  "packages/prompt-enhancer/acceptance/classify.ts",
  "packages/prompt-enhancer/acceptance/classify.test.ts",
  "packages/prompt-enhancer/acceptance/run-matrix.ts",
  "packages/prompt-enhancer/acceptance/README.md",
  "docs/prompt-enhancer/PLAN.md",
  "docs/prompt-enhancer/baseline.json",
];

describe("classifyEnhancement — announcement beyond position 0", () => {
  it("flags every announcement the position-0 rule missed in the recorded baseline", () => {
    for (const enhanced of BASELINE_ANNOUNCEMENT_MISSES) {
      const result = classify({ enhanced });
      expect(result.verdict, enhanced).toBe("bad");
      expect(result.codes, enhanced).toContain("announcement");
    }
  });

  it("keeps the real responses that quote the narration back as good", () => {
    for (const enhanced of LEGITIMATE_QUOTING_REWRITES) {
      const result = classify({
        original: SELF_REFERENTIAL_ORIGINAL,
        enhanced,
        knownPaths: SELF_REFERENTIAL_KNOWN_PATHS,
      });
      expect(result.verdict, enhanced.slice(0, 80)).toBe("good");
      expect(result.codes, enhanced.slice(0, 80)).toEqual([]);
    }
  });

  it("flags a gerund opener but not the imperative form of the same verb", () => {
    expect(classify({ enhanced: "Reviewing the release-please config first." }).codes).toContain(
      "announcement",
    );
    expect(
      classify({ enhanced: "Review the release-please config and report what it does." }).codes,
    ).toEqual([]);
    expect(
      classify({
        enhanced: "Inspect packages/prompt-enhancer/index.ts and report the contradiction.",
      }).codes,
    ).toEqual([]);
  });

  it("requires a retrieval verb, so first-person text carried from the prompt stays good", () => {
    const result = classify({
      original:
        "Please review the open dependabot alerts to see if these resolve them. Next I need to know if this is a dev dependency or app dependency",
      enhanced:
        "Review the open Dependabot alerts and say whether the pending updates resolve them. I need to know whether each package is a devDependency or a production dependency.",
    });
    expect(result.verdict).toBe("good");
    expect(result.codes).toEqual([]);
  });

  it("ignores narration past the announcement window", () => {
    const filler = "Review the release-please configuration and report the findings. ".repeat(8);
    expect(filler.length).toBeGreaterThan(400);
    const result = classify({ enhanced: `${filler}I'll inspect the manifest afterwards.` });
    expect(result.verdict).toBe("good");
    expect(result.codes).toEqual([]);
  });

  it("still flags narration inside the window when the head also quotes it", () => {
    const result = classify({
      original: SELF_REFERENTIAL_ORIGINAL,
      enhanced:
        "The model writes \"I'll inspect the repo\" instead of rewriting. I'll inspect the sources so the rewrite can name the contradiction.",
      knownPaths: SELF_REFERENTIAL_KNOWN_PATHS,
    });
    expect(result.verdict).toBe("bad");
    expect(result.codes).toContain("announcement");
  });
});

describe("classifyEnhancement — refusal", () => {
  it("flags the verbatim haiku refusal", () => {
    const result = classify({
      original: "explain the difference between a semaphore and a mutex",
      enhanced:
        "I appreciate the question, but I'm a prompt rewriter, not an answerer — I can only restate requests about your codebase.",
    });
    expect(result.verdict).toBe("bad");
    expect(result.codes).toContain("refusal");
  });

  it("flags each refusal phrase", () => {
    for (const phrase of [
      "I appreciate the question.",
      "I'm a prompt rewriter and nothing else.",
      "I am a prompt rewriter for coding agents.",
      "This is a rewriter, not an answerer.",
      "I can't do that here.",
      "I cannot answer this.",
      "I won't be answering that.",
      "I'm not able to help with this.",
      "Remember, my job is to rewrite prompts.",
    ]) {
      const result = classify({ enhanced: phrase });
      expect(result.verdict, phrase).toBe("bad");
      expect(result.codes, phrase).toContain("refusal");
    }
  });

  it("does not flag a plain rewrite", () => {
    const result = classify({
      enhanced: "Fix the spelling mistake in README.md and keep the surrounding wording unchanged.",
    });
    expect(result.verdict).toBe("good");
    expect(result.codes).toEqual([]);
  });

  /**
   * The classifier scoring its own corpus as a failure.
   *
   * `fenced-trace.txt` opens "… and I can't tell if the bound is wrong or the
   * code is". The old rule matched the bare substring `"I can't"` anywhere in
   * the response, so the fixture classified against itself came back
   * `verdict=bad codes=[refusal]` — and since `SYSTEM_PROMPT` asks the model to
   * match the prompt's tone, a *faithful* rewrite carrying that first person
   * forward scored the same way. With `CELL_BAD_THRESHOLD` at 0 that failed a
   * whole cell on the harness's own reading of a file it ships.
   *
   * Read from disk rather than inlined: the point is the real fixture text, and
   * a copy in this file could drift away from the one the matrix sends.
   */
  it("does not flag the fenced-trace fixture, which is where the false positive was", async () => {
    const fixture = await fs.readFile(path.join(FIXTURE_DIR, "fenced-trace.txt"), "utf8");
    expect(fixture).toContain("I can't tell if the bound is wrong");

    const result = classify({ original: fixture, enhanced: fixture, knownPaths: [] });
    expect(result.codes).not.toContain("refusal");
    expect(result.verdict).toBe("good");
  });

  it("keeps a user's own inability out of the refusal rule, and a rewriter's in", () => {
    // First person the user wrote and a faithful rewrite carries forward.
    for (const carried of [
      "I can't tell if the bound is wrong or the code is.",
      "I cannot reproduce the failure locally on this branch.",
      "I won't be around after Friday, so land it before then.",
    ]) {
      expect(classify({ enhanced: carried }).codes, carried).not.toContain("refusal");
    }
    // The rewriter declining the job it was given.
    for (const refused of [
      "I can't rewrite that for you.",
      "I cannot comply with this request.",
      "I'm not able to assist with that.",
    ]) {
      expect(classify({ enhanced: refused }).codes, refused).toContain("refusal");
    }
  });

  /**
   * The battery, run in both directions.
   *
   * Requiring a task-shaped object was right; narrowing the vocabulary to go
   * with it was not, and the two were never in tension. Measured against a
   * battery of genuine refusals, the object-only rule missed more of them than
   * the bare-substring rule it replaced — `I don't rewrite`, `Unable to`,
   * `I must decline`, `I refuse`, a modal separated from its object by a comma
   * or three words. Every line below is a way a model has of saying no; the
   * second list is what the same vocabulary must not touch.
   */
  it("catches the ways a model declines the job", () => {
    for (const refusal of [
      "I can't rewrite that.",
      "I cannot help with this request.",
      "I can not do that.",
      "I won't be able to help with that.",
      "I will not respond to that.",
      "I'm not able to assist with that.",
      "I am unable to comply with this request.",
      "I'm not going to rewrite this prompt.",
      "I'm not willing to rewrite that.",
      "Unable to comply with that request.",
      "I don't rewrite prompts like this one.",
      "I do not answer questions of that kind.",
      "I must decline.",
      "I refuse to do that.",
      "That is not something I can help with.",
      "I'm afraid I can't do that.",
      "Sorry, I can't do that.",
      "I'm sorry, but I won't be rewriting this prompt.",
      "Unfortunately I cannot comply.",
      "As an AI, I don't have the ability to do that.",
      "As an AI language model, I cannot rewrite this.",
      "I appreciate the request, but I have to pass.",
      "I'm just a prompt rewriter, not an answerer.",
      "I am a prompt rewriter and cannot answer questions.",
      "My job is to rewrite prompts, not to answer them.",
      "I can't, unfortunately, help with that.",
      "I'm not able to, for policy reasons, rewrite this.",
      "I cannot fulfil this request.",
      "Sorry — I can't produce that rewrite.",
    ]) {
      expect(classify({ enhanced: refusal }).codes, refusal).toContain("refusal");
    }
  });

  it("leaves the user's own voice alone when a rewrite carries it forward", () => {
    for (const carried of [
      "I can't tell if the bound is wrong or the code is.",
      "I cannot reproduce the failure locally on this branch.",
      "I won't be around after Friday, so land it before then.",
      "I can't complete the release because the publish token expired.",
      "I cannot tell whether this will help; explain the tradeoff first.",
      "I don't want to rewrite the whole module, just the slot parser.",
      "I won't be able to test this until Monday — write the repro steps down.",
      "I'm not able to run the suite on my laptop, so fix the CI config instead.",
      "Sorry, this is the third time I've asked: why does the build fail on main?",
      "I'm afraid the snapshot tests are flaky; find the source of the flake.",
      "As an AI safety researcher, I want the eval harness documented.",
      "Explain why the model does not answer questions about its own prompt.",
      "Fix the spelling mistake in README.md and keep the wording unchanged.",
    ]) {
      expect(classify({ enhanced: carried }).codes, carried).not.toContain("refusal");
    }
  });

  it("does not flag a refusal the rewrite is quoting rather than committing", () => {
    // The `self-referential.txt` shape: the prompt is *about* a refusal, so a
    // faithful rewrite quotes one. Masked exactly as announcements are.
    const result = classify({
      enhanced:
        'Explain why the enhancer sometimes answers with "I can\'t rewrite that" instead of returning a rewritten prompt.',
    });
    expect(result.codes).not.toContain("refusal");
  });

  it("ignores a refusal phrase past the window, as the announcement rule does", () => {
    const filler =
      "Update the typo in README.md so the install command matches the published name. ";
    const enhanced = `${filler.repeat(6)}I cannot comply with this request.`;
    expect(enhanced.indexOf("I cannot comply")).toBeGreaterThan(400);
    expect(classify({ enhanced }).codes).not.toContain("refusal");
  });
});

describe("classifyEnhancement — third_person_meta", () => {
  it("flags meta description in the first 200 characters", () => {
    for (const phrase of [
      "The user is asking about release automation.",
      "The user wants to know which packages release.",
      "The user's request concerns dependabot alerts.",
      "They want me to enumerate the affected packages.",
    ]) {
      const result = classify({ enhanced: phrase });
      expect(result.verdict, phrase).toBe("bad");
      expect(result.codes, phrase).toContain("third_person_meta");
    }
  });

  it("ignores the same phrase past the 200-character window", () => {
    const filler =
      "Update the typo in README.md so the install command matches the published name. ";
    const enhanced = `${filler.repeat(4)}The user wants this left otherwise untouched.`;
    expect(enhanced.indexOf("The user wants")).toBeGreaterThan(200);
    const result = classify({ enhanced });
    expect(result.verdict).toBe("good");
    expect(result.codes).toEqual([]);
  });
});

describe("classifyEnhancement — fabricated_path", () => {
  it("flags a path that is in neither the prompt nor the repo", () => {
    const result = classify({
      enhanced: "Update packages/prompt-enhancer/imaginary/helper.ts to fix the typo.",
    });
    expect(result.verdict).toBe("bad");
    expect(result.codes).toContain("fabricated_path");
  });

  it("does not flag a path that exists on disk", () => {
    const result = classify({
      enhanced: "Fix the typo in the README referenced from packages/prompt-enhancer/index.ts.",
    });
    expect(result.verdict).toBe("good");
  });

  it("does not flag a directory that exists on disk", () => {
    const result = classify({
      enhanced: "Fix the typo in the readme under packages/prompt-enhancer.",
    });
    expect(result.verdict).toBe("good");
  });

  it("does not flag a path that appeared in the original prompt", () => {
    const result = classify({
      original: "check src/vendor/thing.ts for the parser bug",
      enhanced: "Explain why the parser in src/vendor/thing.ts misreads the payload.",
    });
    expect(result.verdict).toBe("good");
  });

  it("does not flag prose containing slashes", () => {
    const result = classify({
      enhanced: "Document the input/output contract and say whether it is 24/7 and/or on demand.",
    });
    expect(result.verdict).toBe("good");
    expect(result.codes).toEqual([]);
  });

  it("does not flag English alternation that a real run produced", () => {
    // Both of these were scored `fabricated_path` by an earlier revision of this
    // rule, on real claude-sonnet-5 responses. Neither is a path.
    for (const enhanced of [
      "Check the relevant package.json files, including any root-level package.json/pnpm workspace config.",
      "Identify where the list of packages/paths is defined and how it maps to the packages/* directories.",
    ]) {
      const result = classify({ enhanced });
      expect(result.verdict, enhanced).toBe("good");
      expect(result.codes, enhanced).toEqual([]);
    }
  });

  it("does not flag alternation that reads like a path", () => {
    // Both are real claude-sonnet-5 responses. Neither names a path: a repo
    // path starts at a real top-level directory.
    for (const enhanced of [
      "Check whether package.json/package-lock.json already carries the fixed version.",
      "Say whether the lockfile/package.json files already pin the patched release.",
    ]) {
      const result = classify({
        enhanced,
        knownPaths: [...KNOWN_PATHS, "package.json", "package-lock.json"],
      });
      expect(result.verdict, enhanced).toBe("good");
      expect(result.codes, enhanced).toEqual([]);
    }
  });

  it("does not flag an ESM specifier for a TypeScript file", () => {
    // index.ts imports "./auto.js"; the file on disk is auto.ts.
    const result = classify({
      enhanced: "Trace the auto-enhance state in packages/prompt-enhancer/auto.js.",
      knownPaths: [...KNOWN_PATHS, "packages/prompt-enhancer/auto.ts"],
    });
    expect(result.verdict).toBe("good");
    expect(result.codes).toEqual([]);
  });

  it("still flags a fabricated file under a real directory", () => {
    // Both are real responses: the config lives under .github/workflows/, and
    // the acceptance README under packages/, not docs/.
    for (const enhanced of [
      "Read .github/release-please.yml to see which packages release independently.",
      "Follow the instructions in docs/prompt-enhancer/acceptance/README.md.",
    ]) {
      const result = classify({
        enhanced,
        knownPaths: [
          ...KNOWN_PATHS,
          ".github/workflows/release-please.yml",
          "docs/prompt-enhancer/PLAN.md",
          "packages/prompt-enhancer/acceptance/README.md",
        ],
      });
      expect(result.verdict, enhanced).toBe("bad");
      expect(result.codes, enhanced).toContain("fabricated_path");
    }
  });

  it("does not flag a URL path", () => {
    const result = classify({
      enhanced:
        "Follow the release policy at https://github.com/jmcombs/pi-extensions/blob/main/VERSIONING.md and say which packages release.",
    });
    expect(result.verdict).toBe("good");
    expect(result.codes).toEqual([]);
  });
});

describe("classifyEnhancement — echo, empty, truncated", () => {
  it("flags a single set_editor_text as an echo (no rewrite arrived)", () => {
    const result = classify({
      enhanced: "fix the typo in the readme",
      setEditorTextCount: 1,
    });
    expect(result.verdict).toBe("bad");
    expect(result.codes).toContain("echo");
  });

  it("accepts a rewrite byte-equal to its original when a rewrite really arrived", () => {
    const original = "explain the difference between a semaphore and a mutex";
    const result = classify({ original, enhanced: original, setEditorTextCount: 2 });
    expect(result.verdict).toBe("good");
    expect(result.codes).toEqual([]);
  });

  it("flags an empty rewrite", () => {
    const result = classify({ enhanced: "   \n  " });
    expect(result.verdict).toBe("bad");
    expect(result.codes).toContain("empty");
  });

  it("flags a provider-signalled truncation", () => {
    const result = classify({
      enhanced: "Fix the typo in README.md, specifically the",
      stopReason: "length",
    });
    expect(result.verdict).toBe("bad");
    expect(result.codes).toContain("truncated");
  });

  it("does not flag a normal stop reason", () => {
    const result = classify({
      enhanced: "Fix the typo in README.md and leave the rest of the file untouched.",
      stopReason: "stop",
    });
    expect(result.verdict).toBe("good");
  });
});

describe("classifyEnhancement — traps", () => {
  it("accepts a rewrite quoting a fixture that ships control tokens", () => {
    const result = classify({
      original:
        "check packages/steward/core/__fixtures__/llama/slots-busy.json and tell me why the slot parser thinks the router is busy",
      enhanced:
        "Read packages/steward/core/__fixtures__/llama/slots-busy.json — whose prompt field contains <|im_start|>system and <|im_end|> markers — and explain why the slot parser reports the router as busy.",
    });
    expect(result.verdict).toBe("good");
    expect(result.codes).toEqual([]);
  });
});

describe("looksLikeHostFailure", () => {
  const REAL_STARTUP_FAILURE =
    'Error: Unknown provider "llama.cpp". Use --list-models to see available providers/models.\n';

  it("flags a non-zero exit that emitted no set_editor_text", () => {
    expect(looksLikeHostFailure({ exitCode: 1, setEditorTextCount: 0, stderrTail: "" })).toBe(true);
  });

  it("flags the recorded startup failure even without an exit code", () => {
    expect(
      looksLikeHostFailure({
        exitCode: null,
        setEditorTextCount: 0,
        stderrTail: REAL_STARTUP_FAILURE,
      }),
    ).toBe(true);
  });

  /**
   * The safety property: the pre-replace echo is emitted before any model call,
   * so a call that emitted one reached the enhancer. Whatever `pi` does after
   * that, the call is scored as a measurement — a host failure can never
   * absolve a real enhancer failure.
   */
  it("never absolves a call the enhancer actually reached", () => {
    expect(
      looksLikeHostFailure({
        exitCode: 1,
        setEditorTextCount: 1,
        stderrTail: REAL_STARTUP_FAILURE,
      }),
    ).toBe(false);
    expect(looksLikeHostFailure({ exitCode: 1, setEditorTextCount: 2, stderrTail: "" })).toBe(
      false,
    );
  });

  it("leaves a clean call alone", () => {
    expect(looksLikeHostFailure({ exitCode: 0, setEditorTextCount: 2, stderrTail: "" })).toBe(
      false,
    );
    expect(
      looksLikeHostFailure({
        exitCode: 0,
        setEditorTextCount: 0,
        stderrTail: "warning: something benign\n",
      }),
    ).toBe(false);
  });

  it("is not a rewrite scorer: an empty rewrite from a healthy host still scores", () => {
    const result = classify({ enhanced: "", setEditorTextCount: 2 });
    expect(result.codes).toContain("empty");
    expect(looksLikeHostFailure({ exitCode: 0, setEditorTextCount: 2, stderrTail: "" })).toBe(
      false,
    );
  });
});

// ── Fenced samples and misspelled paths ────────────────────────────────

const TRACE = [
  "FAIL  packages/prompt-enhancer/index.test.ts > buildRecentTurns > clips a long turn",
  "AssertionError: expected 607 to be less than 360",
  " ❯ packages/prompt-enhancer/index.test.ts:348:32",
  '    348|     expect((out ?? "").length).toBeLessThan(360);',
].join("\n");

const FENCED_ORIGINAL = `this keeps failing and I can't tell why:\n\n\`\`\`\n${TRACE}\n\`\`\`\n\nwork out which one to change`;

describe("classifyEnhancement — fenced samples", () => {
  it("passes a rewrite that reproduces the block byte for byte", () => {
    const result = classify({
      original: FENCED_ORIGINAL,
      enhanced: `Determine whether the assertion bound or the implementation is wrong, given this failure:\n\n\`\`\`\n${TRACE}\n\`\`\``,
    });
    expect(result.verdict).toBe("good");
    expect(result.codes).toEqual([]);
  });

  it("flags a rewrite that dropped the block entirely", () => {
    const result = classify({
      original: FENCED_ORIGINAL,
      enhanced:
        "Determine whether the assertion bound or the implementation is wrong for the failing buildRecentTurns test.",
    });
    expect(result.verdict).toBe("bad");
    expect(result.codes).toContain("code_block_mangled");
  });

  it("flags a rewrite that retyped the trace instead of carrying it", () => {
    const result = classify({
      original: FENCED_ORIGINAL,
      // One number changed. That is exactly the damage the rule exists for:
      // the payload of a trace is its numbers and identifiers.
      enhanced: `Work out which to change:\n\n\`\`\`\n${TRACE.replace("607", "600")}\n\`\`\``,
    });
    expect(result.verdict).toBe("bad");
    expect(result.codes).toContain("code_block_mangled");
  });

  it("tolerates line-ending and trailing-whitespace differences", () => {
    // Transport artifacts, not the model rewording anything.
    const roughed = `${TRACE.replace(/\n/g, "  \r\n")}   `;
    const result = classify({
      original: FENCED_ORIGINAL,
      enhanced: `Work out which to change:\n\n\`\`\`\n${roughed}\n\`\`\``,
    });
    expect(result.codes).not.toContain("code_block_mangled");
  });

  it("accepts the block re-fenced with a language tag or moved in the rewrite", () => {
    const result = classify({
      original: FENCED_ORIGINAL,
      enhanced: `\`\`\`text\n${TRACE}\n\`\`\`\n\nWork out whether the bound or the code is wrong.`,
    });
    expect(result.codes).not.toContain("code_block_mangled");
  });

  it("is inert on a prompt with no fenced block at all", () => {
    // Every fixture the recorded 216-call baseline was measured on is in this
    // shape, so the rule cannot retroactively change any of those verdicts.
    const result = classify({ enhanced: "Fix the typo in README.md." });
    expect(result.codes).not.toContain("code_block_mangled");
  });
});

describe("classifyEnhancement — misspelled paths", () => {
  const TYPO_ORIGINAL =
    "fix the widgit colour in packages/prompt-enhncer/index.ts and updaet the tets";

  it("records that the rewrite carried the misspelled path forward", () => {
    const result = classify({
      original: TYPO_ORIGINAL,
      enhanced: "Fix the widget colour in packages/prompt-enhncer/index.ts and update the tests.",
    });
    expect(result.signals).toContain("typo_path_carried");
    // A signal, never a verdict: both behaviours are defensible.
    expect(result.verdict).toBe("good");
    expect(result.codes).toEqual([]);
  });

  it("records that the rewrite corrected it", () => {
    const result = classify({
      original: TYPO_ORIGINAL,
      enhanced: "Fix the widget colour in packages/prompt-enhancer/index.ts and update the tests.",
    });
    expect(result.signals).toContain("typo_path_corrected");
    expect(result.verdict).toBe("good");
  });

  it("records that the rewrite lost the path altogether", () => {
    const result = classify({
      original: TYPO_ORIGINAL,
      enhanced: "Fix the widget colour in the prompt enhancer and update the tests.",
    });
    expect(result.signals).toContain("typo_path_dropped");
  });

  it("does not treat a path that really exists as a misspelling", () => {
    const result = classify({
      original: "look at packages/prompt-enhancer/index.ts",
      enhanced: "Explain what packages/prompt-enhancer/index.ts does.",
    });
    expect(result.signals).toEqual([]);
  });

  it("does not invent a near miss for a path nothing resembles", () => {
    const result = classify({
      original: "open vendor/thirdparty/zzzz.ts",
      enhanced: "Open vendor/thirdparty/zzzz.ts.",
    });
    expect(result.signals).toEqual([]);
  });

  it("leaves signals empty for every fixture shape the baseline used", () => {
    for (const original of [
      "fix the typo in the readme",
      "explain the difference between a semaphore and a mutex",
      "where does release-please decide which packages get their own release PR in this repo",
      "check packages/steward/core/__fixtures__/llama/slots-busy.json and tell me why",
    ]) {
      const result = classify({ original, enhanced: "Some rewrite." });
      expect(result.signals, original).toEqual([]);
    }
  });
});
