export interface AgentPairRequest {
  port: number;
  state: string;
}

interface AgentPairCallback {
  url: string;
  body: {
    pairing_code: string;
    state: string;
  };
}

const PAIRING_STATE = /^[A-Za-z0-9_-]{24,128}$/;

export function parseAgentPairRequest(search: string): AgentPairRequest | null {
  const params = new URLSearchParams(search);
  const rawPort = params.get("agent_pair");
  const state = params.get("agent_state") ?? "";
  if (!rawPort || !/^[0-9]{1,5}$/.test(rawPort) || !PAIRING_STATE.test(state)) {
    return null;
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return null;
  }
  return { port, state };
}

export function buildAgentPairCallback(
  request: AgentPairRequest,
  pairingCode: string,
): AgentPairCallback {
  return {
    url: `http://127.0.0.1:${request.port}/pair`,
    body: {
      pairing_code: pairingCode,
      state: request.state,
    },
  };
}
