import "server-only";
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from "livekit-server-sdk";

/** The name the voice worker registers under. Must match its AGENT_NAME. */
export const WORKER_NAME = process.env.LIVEKIT_AGENT_NAME || "neato-builder";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/**
 * A 10-minute token for one browser to join one new room. Joining dispatches the worker with
 * the agent's id, so the worker loads that agent's published version for this call.
 */
export async function callToken(opts: { agentId: string; userId: string }) {
  const room = `talk-${opts.agentId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
  const at = new AccessToken(need("LIVEKIT_API_KEY"), need("LIVEKIT_API_SECRET"), {
    identity: `builder-${opts.userId}`,
    ttl: "10m",
  });
  at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true });
  at.roomConfig = new RoomConfiguration({
    agents: [
      new RoomAgentDispatch({
        agentName: WORKER_NAME,
        metadata: JSON.stringify({ agent_id: opts.agentId }),
      }),
    ],
  });
  return { url: need("LIVEKIT_URL"), token: await at.toJwt(), room };
}

/**
 * A short token for one anonymous visitor on an embedded website. Same dispatch as a test
 * call, but the room starts with "web-" so the call is saved as a website call, and the token
 * lives only as long as one call may last.
 */
export async function visitorToken(opts: { agentId: string }) {
  const room = `web-${opts.agentId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
  const at = new AccessToken(need("LIVEKIT_API_KEY"), need("LIVEKIT_API_SECRET"), {
    identity: `visitor-${crypto.randomUUID().slice(0, 12)}`,
    ttl: "15m",
  });
  at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false });
  at.roomConfig = new RoomConfiguration({
    agents: [
      new RoomAgentDispatch({
        agentName: WORKER_NAME,
        metadata: JSON.stringify({ agent_id: opts.agentId }),
      }),
    ],
  });
  return { url: need("LIVEKIT_URL"), token: await at.toJwt(), room };
}
