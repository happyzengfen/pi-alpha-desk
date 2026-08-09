import { NextRequest, NextResponse } from "next/server";
import { resolveTheme, type ThemeVariant } from "@/lib/theme";
import { isThemeProjectCwdAllowed, isThemeSetNameSafe } from "@/lib/theme-access";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  try {
    const { name } = await params;
    const decodedName = decodeURIComponent(name);
    const { searchParams } = new URL(request.url);
    const cwd = searchParams.get("cwd") || undefined;
    const mode = (searchParams.get("mode") || "dark") as ThemeVariant;
    if (!isThemeSetNameSafe(decodedName)) {
      return NextResponse.json({ error: "Invalid theme name" }, { status: 400 });
    }
    if (!await isThemeProjectCwdAllowed(cwd)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const resolved = resolveTheme(
      decodedName,
      mode === "light" ? "light" : "dark",
      cwd,
      { allowDirectPath: false },
    );

    if (!resolved) {
      return NextResponse.json(
        { error: `Theme "${name}" variant "${mode}" not found` },
        { status: 404 },
      );
    }

    return NextResponse.json(resolved);
  } catch (error) {
    console.error("Failed to resolve theme:", error);
    return NextResponse.json(
      { error: "Failed to resolve theme" },
      { status: 500 },
    );
  }
}
