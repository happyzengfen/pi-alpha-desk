import { randomUUID } from "crypto";
import { renameSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

export function writeFileAtomicSync(
  path: string,
  contents: string | Uint8Array,
  options: { mode?: number } = {},
): void {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}-${randomUUID()}.tmp`);
  let operationFailed = false;

  try {
    writeFileSync(temporaryPath, contents, {
      flag: "wx",
      mode: options.mode,
      flush: true,
    });
    renameSync(temporaryPath, path);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !operationFailed) {
        throw error;
      }
    }
  }
}

/**
 * Atomically replaces a sensitive file while ensuring a newly created file is
 * private by default. The caller is responsible for creating its parent.
 */
export function writePrivateFileAtomicSync(path: string, contents: string): void {
  writeFileAtomicSync(path, contents, { mode: 0o600 });
}
