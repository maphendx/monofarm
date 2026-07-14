import { describe, expect, it } from "bun:test";

import { AGENT_RELEASE_PUBLIC_KEY } from "./agentReleaseTrust";


describe("agent release trust", () => {
  it("matches the committed CI trust root", async () => {
    const source = await Bun.file(
      new URL("../../../agent/release_public_key.b64", import.meta.url),
    ).text();

    expect(AGENT_RELEASE_PUBLIC_KEY).toBe(source.trim());
    expect(AGENT_RELEASE_PUBLIC_KEY).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });
});
