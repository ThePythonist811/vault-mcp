import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

// Machine endpoints authenticate themselves (bearer token / PKCE / client auth).
const isPublicApi = createRouteMatcher([
  "/api/mcp(.*)",
  "/api/oauth/token(.*)",
  "/api/oauth/register(.*)",
  "/api/oauth/revoke(.*)",
  "/.well-known/(.*)",
]);

// Everything a human uses requires a Clerk session; the allowlist check happens in the pages/routes.
const isProtected = createRouteMatcher([
  "/consent(.*)",
  "/proposals(.*)",
  "/activity(.*)",
  "/connect(.*)",
  "/api/proposals(.*)",
  "/api/connections(.*)",
  "/api/oauth/authorize(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (isPublicApi(req)) return NextResponse.next();
  if (isProtected(req)) await auth.protect();
  return NextResponse.next();
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
