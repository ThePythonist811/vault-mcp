import { NextResponse } from "next/server";
import { getViewer, isSameOrigin } from "@/lib/auth/clerk";
import { appBaseUrl } from "@/lib/config";
import { decideProposal } from "@/lib/proposals";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(req, appBaseUrl())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const viewer = await getViewer();
  if (viewer.state !== "ok") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const decision = (await req.formData()).get("decision");
  if (decision !== "approve" && decision !== "reject") {
    return NextResponse.json({ error: "bad decision" }, { status: 400 });
  }
  try {
    await decideProposal(id, decision, viewer.clerkUserId);
  } catch {
    // Already decided/expired: just show the current state.
  }
  return NextResponse.redirect(`${appBaseUrl()}/proposals#${id}`, 303);
}
