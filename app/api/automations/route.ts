import { NextResponse } from "next/server";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { AutomationInputError, AutomationHubError, automationCommand, automationSnapshot, automationWhy, isAutomationControlAuthorized } from "@/lib/automation/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown) {
  const status = error instanceof AutomationHubError ? error.status : error instanceof AutomationInputError || error instanceof SyntaxError ? 400 : 503;
  return NextResponse.json({ error: error instanceof Error ? error.message : "Automation is unavailable" }, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try {
    const query = new URL(request.url).searchParams;
    const id = query.get("why") ?? query.get("before");
    if (id !== null && (!/^[1-9]\d{0,14}$/.test(id) || !Number.isSafeInteger(Number(id)))) throw new AutomationInputError("Invalid id");
    const data = query.has("why") ? { facts: await automationWhy(Number(id)) } : await automationSnapshot(id ? Number(id) : undefined);
    return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const reader = request.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (reader) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) { await reader.cancel(); return NextResponse.json({ error: "Configuration is too large" }, { status: 413 }); }
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new AutomationInputError("Expected an object");
    const internal = isAutomationControlAuthorized(request);
    if (["suspend_worker", "resume_worker"].includes(String(body.action)) && !internal) return NextResponse.json({ error: "Internal automation control required" }, { status: 403 });
    return NextResponse.json(await automationCommand(body, internal), { headers: { "cache-control": "no-store" } });
  } catch (error) { return failure(error); }
}
