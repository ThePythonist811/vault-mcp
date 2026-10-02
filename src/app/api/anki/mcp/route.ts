import { NextResponse } from "next/server";
import { hasScope, loadClient, resolveAccessToken, SCOPE_ANKI } from "@/lib/auth/oauth";
import { clerkIdForUser } from "@/lib/auth/clerk";
import { appBaseUrl, isAllowedClerkUser } from "@/lib/config";
import { audit } from "@/lib/audit";
import { describeCall, filterToolList, isBlockedTool, sseToolFilter, type JsonRpcMessage } from "@/lib/anki";

export const dynamic = "force-dynamic";

const UPSTREAM = () => process.env.ANKI_MCP_URL ?? "http://anki:3141/";

function unauthorized(description: string) {
  return NextResponse.json(
    { error: "invalid_token", error_description: description },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer realm="anki", resource_metadata="${appBaseUrl()}/.well-known/oauth-protected-resource/api/anki/mcp"`,
      },
    },
  );
}

async function authenticate(req: Request) {
  const header = req.headers.get("authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) return { error: unauthorized("missing bearer token") };
  const token = await resolveAccessToken(header.slice(7).trim());
  if (!token) return { error: unauthorized("invalid or expired token") };
  if (!hasScope(token.scope, SCOPE_ANKI)) return { error: unauthorized("token is not valid for this resource") };
  if (!isAllowedClerkUser(await clerkIdForUser(token.userId))) return { error: unauthorized("user not allowed") };
  return { token };
}

// Only these headers travel between Claude and the add-on; the client's bearer
// token is replaced by the internal add-on key.
const FORWARD_REQ = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
const FORWARD_RES = ["content-type", "mcp-session-id", "mcp-protocol-version", "cache-control"];

function upstreamHeaders(req: Request): Headers {
  const h = new Headers();
  for (const k of FORWARD_REQ) {
    const v = req.headers.get(k);
    if (v) h.set(k, v);
  }
  h.set("authorization", `Bearer ${process.env.ANKI_MCP_API_KEY ?? ""}`);
  return h;
}

function blockedError(id: JsonRpcMessage["id"], name: string) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code: -32601, message: `Tool "${name}" is disabled on this server (note types, templates and GUI tools are blocked).` },
  };
}

async function relay(req: Request, body: string | undefined) {
  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM(), { method: req.method, headers: upstreamHeaders(req), body });
  } catch {
    return NextResponse.json({ error: "Anki is not reachable right now" }, { status: 502 });
  }
  const headers = new Headers();
  for (const k of FORWARD_RES) {
    const v = upstream.headers.get(k);
    if (v) headers.set(k, v);
  }
  const ct = upstream.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream") && upstream.body) {
    return new Response(upstream.body.pipeThrough(sseToolFilter()), { status: upstream.status, headers });
  }
  if (ct.includes("application/json")) {
    const text = await upstream.text();
    try {
      const data = JSON.parse(text) as JsonRpcMessage | JsonRpcMessage[];
      for (const m of Array.isArray(data) ? data : [data]) filterToolList(m);
      return new Response(JSON.stringify(data), { status: upstream.status, headers });
    } catch {
      return new Response(text, { status: upstream.status, headers });
    }
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (auth.error) return auth.error;
  const actor = `client:${auth.token.clientId}`;

  const body = await req.text();
  let parsed: JsonRpcMessage | JsonRpcMessage[];
  try {
    parsed = JSON.parse(body);
  } catch {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];

  for (const m of messages) {
    if (m.method !== "tools/call") continue;
    const name = String(m.params?.name ?? "");
    if (isBlockedTool(name)) {
      await audit({ actor, action: `anki.${name}`, detail: "blocked by gateway", ok: false });
      return NextResponse.json(Array.isArray(parsed) ? [blockedError(m.id, name)] : blockedError(m.id, name));
    }
    await audit({ actor, action: `anki.${name}`, detail: describeCall(m.params?.arguments), ok: true });
  }
  if (messages.some((m) => m.method === "initialize")) {
    const client = await loadClient(auth.token.clientId);
    await audit({ actor, action: "anki.connect", detail: client?.name ?? auth.token.clientId, ok: true });
  }
  return relay(req, body);
}

export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (auth.error) return auth.error;
  return relay(req, undefined);
}

export async function DELETE(req: Request) {
  const auth = await authenticate(req);
  if (auth.error) return auth.error;
  return relay(req, undefined);
}
