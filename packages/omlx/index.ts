/**
 * @jmcombs/pi-omlx — omlx provider for Pi.
 *
 * Registers native provider `omlx`. Catalog, classifiers, and `/omlx` arrive
 * in later phases. GGUF models are not supported.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createOmlxProvider } from "./provider.js";

export default function (pi: ExtensionAPI): void {
  pi.registerProvider(createOmlxProvider().provider);
}
