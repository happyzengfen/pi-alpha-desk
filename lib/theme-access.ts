import { getAllowedFileRoots, isFilePathAllowed } from "./file-access";

export function isThemeSetNameSafe(name: string): boolean {
  return Boolean(name) && name !== "." && name !== ".." && !/[\\/\0]/.test(name);
}

export async function isThemeProjectCwdAllowed(cwd: string | undefined): Promise<boolean> {
  if (!cwd) return true;
  return isFilePathAllowed(cwd, await getAllowedFileRoots());
}
