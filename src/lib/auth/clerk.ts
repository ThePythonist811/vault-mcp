import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { isAllowedClerkUser } from "@/lib/config";

export type Viewer =
  | { state: "signed-out" }
  | { state: "forbidden"; clerkUserId: string }
  | { state: "ok"; clerkUserId: string; userId: string };

/** Signed in AND on the allowlist. Anything else gets no vault access. */
export async function getViewer(): Promise<Viewer> {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) return { state: "signed-out" };
  if (!isAllowedClerkUser(clerkUserId)) return { state: "forbidden", clerkUserId };
  return { state: "ok", clerkUserId, userId: await ensureUserRow(clerkUserId) };
}

export async function ensureUserRow(clerkUserId: string): Promise<string> {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clerkUserId, clerkUserId))
    .limit(1);
  if (existing) return existing.id;
  const [created] = await db
    .insert(users)
    .values({ clerkUserId })
    .onConflictDoNothing()
    .returning({ id: users.id });
  if (created) return created.id;
  const [again] = await db.select({ id: users.id }).from(users).where(eq(users.clerkUserId, clerkUserId));
  return again.id;
}

export async function clerkIdForUser(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ clerkUserId: users.clerkUserId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.clerkUserId ?? null;
}

/** Same-origin check for state-changing form posts (defence in depth next to SameSite cookies). */
export function isSameOrigin(req: Request, baseUrl: string): boolean {
  const origin = req.headers.get("origin");
  if (origin && origin !== "null") return origin === new URL(baseUrl).origin;
  // Browsers may send `Origin: null` (privacy settings, referrer policy); the
  // browser-controlled Sec-Fetch-Site header cannot be set by page scripts.
  return req.headers.get("sec-fetch-site") === "same-origin";
}
