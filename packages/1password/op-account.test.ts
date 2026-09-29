import { describe, expect, it } from "vitest";
import { opAccountFromUnknown } from "./op-account.js";

describe("opAccountFromUnknown", () => {
  it("opAccountFromUnknown keeps only JSON account strings", () => {
    const parsed = opAccountFromUnknown({
      name: "Ada",
      email: "ada@example.com",
      account_uuid: "acct-uuid",
      url: "https://example.1password.com",
      nested: { team: "engineering" },
      extra: undefined,
    });
    expect(parsed).toEqual({
      name: "Ada",
      email: "ada@example.com",
      account_uuid: "acct-uuid",
      url: "https://example.1password.com",
    });
    expect(opAccountFromUnknown("not-an-account")).toBeNull();
  });
});
