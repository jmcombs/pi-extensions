/**
 * JSON-compatible 1Password account fields from `op whoami --format json`.
 * Copies only the four string keys; every other property is dropped.
 */

export function opAccountFromUnknown(
  value: unknown,
): { name?: string; email?: string; account_uuid?: string; url?: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const account: { name?: string; email?: string; account_uuid?: string; url?: string } = {};
  if ("name" in value && typeof value.name === "string") account.name = value.name;
  if ("email" in value && typeof value.email === "string") account.email = value.email;
  if ("account_uuid" in value && typeof value.account_uuid === "string") {
    account.account_uuid = value.account_uuid;
  }
  if ("url" in value && typeof value.url === "string") account.url = value.url;
  return account;
}
