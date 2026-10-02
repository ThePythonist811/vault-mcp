import { NextResponse } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildMcpServer } from "@/lib/mcp/server";
import { hasScope, loadClient, resolveAccessToken, SCOPE_READ } from "@/lib/auth/oauth";
import { clerkIdForUser } from "@/lib/auth/clerk";
import { appBaseUrl, isAllowedClerkUser } from "@/lib/config";

export const dynamic = "force-dynamic";

function unauthorized(description: string) {
  return NextResponse.json(
    { error: "invalid_token", error_description: description },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer realm="vault-mcp", resource_metadata="${appBaseUrl()}/.well-known/oauth-protected-resource"`,
      },
    },
  );
}

async function handle(req: Request) {
  const header = req.headers.get("authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) return unauthorized("missing bearer token");
  const token = await resolveAccessToken(header.slice(7).trim());
  if (!token) return unauthorized("invalid or expired token");
  // Tokens are bound to one resource: an Anki token must not open the vault.
  if (!hasScope(token.scope, SCOPE_READ)) return unauthorized("token is not valid for this resource");
  // Re-check the allowlist on every request, so removing a user cuts off existing tokens too.
  if (!isAllowedClerkUser(await clerkIdForUser(token.userId))) return unauthorized("user not allowed");

  const client = await loadClient(token.clientId);
  const server = buildMcpServer({
    userId: token.userId,
    clientId: token.clientId,
    clientName: client?.name ?? null,
    scope: token.scope,
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await server.close().catch(() => {});
  }
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
