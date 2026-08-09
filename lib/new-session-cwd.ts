import { realpathSync, statSync } from "fs";
import { isFilePathAllowed } from "./file-access";

/**
 * Resolve both the requested cwd and allowed roots before comparing them so a
 * symlink beneath an allowed root cannot redirect a new session elsewhere.
 */
export function resolveAllowedNewSessionCwd(cwd: string, allowedRoots: Set<string>): string | null {
  try {
    const realCwd = realpathSync(cwd);
    if (!statSync(realCwd).isDirectory()) return null;

    const realAllowedRoots = new Set<string>();
    for (const root of allowedRoots) {
      try {
        const realRoot = realpathSync(root);
        if (statSync(realRoot).isDirectory()) realAllowedRoots.add(realRoot);
      } catch {
        // Stale roots are not authorization grants.
      }
    }

    return isFilePathAllowed(realCwd, realAllowedRoots) ? realCwd : null;
  } catch {
    return null;
  }
}
