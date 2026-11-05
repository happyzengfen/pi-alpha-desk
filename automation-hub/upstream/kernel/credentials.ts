// Run tokens and card links derive from the master key, so they're never stored. Access keys are kept only as hashes.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { rows, type Row, type View } from "./evolve.ts";
import type { Result } from "../protocol/validate.ts";

export type Environment = { secret: string; publicUrl: string; transformResult?: (run: Record<string, any>, result: Result) => Result; canClaim?: (view: View, run: Row) => boolean };

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export const credential = (env: Environment, purpose: string, ...parts: unknown[]) =>
  createHmac("sha256", env.secret)
    .update(JSON.stringify([purpose, ...parts]))
    .digest("base64url");

export function whose(view: View, kind: string, key: string): string | null {
  if (!key) return null;
  const given = Buffer.from(digest(key), "hex");
  const found = rows(view, "keys").find(
    (row) => row.kind === kind && timingSafeEqual(Buffer.from(row.hash, "hex"), given),
  );
  return found?.name ?? null;
}
