import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { automationEventStream } from "@/lib/automation/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try { return await automationEventStream(request); }
  catch { return NextResponse.json({ error: "Automation is not connected" }, { status: 503 }); }
}
