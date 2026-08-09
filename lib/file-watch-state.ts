export interface FileWatchSnapshot {
  mtimeMs: number;
  size: number;
}

export function didFileWatchSnapshotChange(
  previous: FileWatchSnapshot | null,
  current: FileWatchSnapshot | null,
): boolean {
  if (previous === null || current === null) return previous !== current;
  return previous.mtimeMs !== current.mtimeMs || previous.size !== current.size;
}
