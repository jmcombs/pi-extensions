/**
 * `/grok_setup` flow.
 *
 * When xAI OAuth is already in auth.json, show a setup card so the user can
 * keep using SuperGrok / X Premium or override with the 1Password API-key
 * onboarding dialog. The choice is persisted in settings.json.
 */

import { onboardSecret } from "@jmcombs/pi-1password";
import { hasXaiOAuth, writeCredentialPreference } from "./auth.js";
import { selectInBorderedPopup, type UiContext } from "./ui/bordered-popups.js";

export interface SetupResult {
  readonly ok: boolean;
  readonly message: string;
}

const CANCELLED: SetupResult = { ok: false, message: "Setup cancelled." };

/**
 * Interactive Grok Search credential setup.
 *
 * @param ctx Any context that exposes `ui` (command handler, tool execute, or `{ ui }` double).
 */
export async function runGrokSetup(ctx: UiContext): Promise<SetupResult> {
  if (await hasXaiOAuth()) {
    const choice = await selectInBorderedPopup(ctx, {
      title: "Grok Search setup",
      message:
        "xAI OAuth (SuperGrok / X Premium) was discovered and can be used for Grok Search.\n" +
        "Use it, or override with an API key?",
      items: [
        {
          value: "oauth",
          label: "Use xAI OAuth",
          description: "SuperGrok / X Premium subscription",
        },
        {
          value: "api_key",
          label: "Use an API key instead",
          description: "1Password vault or manual key",
        },
        { value: "cancel", label: "Cancel" },
      ],
      helpText: "↑↓ • Enter • Esc = cancel",
      maxVisible: 5,
    });
    if (!choice || choice === "cancel") return CANCELLED;
    if (choice === "oauth") {
      await writeCredentialPreference("oauth");
      return { ok: true, message: "Grok Search will use your xAI OAuth subscription." };
    }
    const result = await onboardSecret(ctx, { name: "grok", label: "Grok / xAI" });
    if (result.ok) await writeCredentialPreference("api_key");
    return result;
  }

  const result = await onboardSecret(ctx, { name: "grok", label: "Grok / xAI" });
  if (result.ok) await writeCredentialPreference("api_key");
  return result;
}
