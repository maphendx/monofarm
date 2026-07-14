import { describe, expect, it } from "bun:test";

import {
  buildAgentPairCallback,
  parseAgentPairRequest,
} from "./agentPairing";

describe("agent device browser pairing", () => {
  it("accepts only a valid loopback callback request", () => {
    expect(
      parseAgentPairRequest("?agent_pair=4747&agent_state=state_abcdefghijklmnopqrstuvwxyz"),
    ).toEqual({ port: 4747, state: "state_abcdefghijklmnopqrstuvwxyz" });
    expect(parseAgentPairRequest("?agent_pair=0&agent_state=state_abcdefghijklmnopqrstuvwxyz")).toBeNull();
    expect(parseAgentPairRequest("?agent_pair=4747&agent_state=short")).toBeNull();
  });

  it("sends a one-time pairing code and never a user token", () => {
    const callback = buildAgentPairCallback(
      { port: 4747, state: "state_abcdefghijklmnopqrstuvwxyz" },
      "mf_pair_once",
    );

    expect(callback.url).toBe("http://127.0.0.1:4747/pair");
    expect(callback.body).toEqual({
      pairing_code: "mf_pair_once",
      state: "state_abcdefghijklmnopqrstuvwxyz",
    });
    expect(JSON.stringify(callback)).not.toContain("token");
  });
});
