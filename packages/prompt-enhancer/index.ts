/**
 * @jmcombs/pi-prompt-enhancer — TODO: short description.
 *
 * This file is the extension's entry point. Pi loads it via jiti, so
 * TypeScript works without a build step.
 *
 * Pi loads the default-exported factory function once per session and passes
 * an `ExtensionAPI` instance. Use that instance to register tools, commands,
 * shortcuts, and event handlers.
 *
 * See:
 *   - PLAN.md (project conventions)
 *   - packages/_template/TEMPLATE.md (how to adapt this scaffold)
 *   - https://pi.dev/docs/extensions
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";

// ── Tool parameter schemas ─────────────────────────────────────────────
//
// TypeBox schemas double as runtime validators (used by Pi) and TypeScript
// types (via `Static<typeof ...>`). Export the inferred type when other
// extensions might want to type a `tool_call` event for this tool.

const exampleToolSchema = Type.Object({
  message: Type.String({
    description: "The message to echo back.",
  }),
});

export type ExampleToolInput = Static<typeof exampleToolSchema>;

// ── Extension factory ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  // Example tool — demonstrates the standard return shape.
  // Replace with the tool(s) this extension actually provides.
  pi.registerTool({
    name: "example_echo",
    label: "Example Echo",
    description: "Echoes the provided message back to the user.",
    parameters: exampleToolSchema,
    // Real tools almost always do async work (`fetch`, file I/O, etc.) and
    // should be `async`. The skeleton returns synchronously to keep the
    // example minimal; replace this body with your actual implementation.
    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return Promise.resolve({
        content: [{ type: "text", text: `Echo: ${params.message}` }],
        details: { received: params.message },
      });
    },
  });

  // Example command — demonstrates the standard handler shape.
  // Replace with the command(s) this extension actually provides.
  pi.registerCommand("example-hello", {
    description: "Print a greeting in the TUI.",
    handler: (args, ctx) => {
      const target = args.trim() || "world";
      ctx.ui.notify(`Hello, ${target}!`, "info");
      return Promise.resolve();
    },
  });
}
