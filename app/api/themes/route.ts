import { NextRequest, NextResponse } from "next/server";
import { listThemeSets } from "@/lib/theme";
import { isThemeProjectCwdAllowed } from "@/lib/theme-access";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const cwd = searchParams.get("cwd") || undefined;
    if (!await isThemeProjectCwdAllowed(cwd)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const themeSets = listThemeSets(cwd);

    return NextResponse.json({ themeSets });
  } catch (error) {
    console.error("Failed to list themes:", error);
    return NextResponse.json(
      { error: "Failed to list themes" },
      { status: 500 },
    );
  }
}
