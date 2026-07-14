import { describe, expect, it } from "bun:test";

import { getAgentReleaseHealth, togglePrinterAssignment } from "./agentFleet";


describe("agent fleet state", () => {
  it("keeps printer assignments unique and sorted", () => {
    expect(togglePrinterAssignment([3, 1], 2)).toEqual([1, 2, 3]);
    expect(togglePrinterAssignment([3, 1], 1)).toEqual([3]);
  });

  it("distinguishes current, outdated and unavailable releases", () => {
    expect(getAgentReleaseHealth("0.9.1", "0.9.1", true)).toBe("current");
    expect(getAgentReleaseHealth("0.8.9", "0.9.1", true)).toBe("update_required");
    expect(getAgentReleaseHealth(null, "0.9.1", true)).toBe("not_connected");
    expect(getAgentReleaseHealth("0.9.1", "0.9.1", false)).toBe("release_unavailable");
  });
});
