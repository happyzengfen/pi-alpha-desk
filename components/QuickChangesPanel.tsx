"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowClockwise, CaretRight, Spinner } from "@phosphor-icons/react";
import { getFileIcon } from "./FileIcons";
import { getFileName, getRelativeFilePath } from "@/lib/file-paths";
import type { GitFileStatus, GitFileStatusKind, GitStatusResponse } from "@/lib/git-types";
import { useI18n } from "@/hooks/useI18n";

interface Props {
  cwd: string;
  refreshKey?: number;
  onOpenFile: (filePath: string, fileName: string, options?: { initialDisplayMode?: "diff" }) => void;
}

const GIT_STATUS_COLORS: Record<GitFileStatusKind, string> = {
  modified: "var(--git-status-modified)",
  added: "var(--git-status-added)",
  deleted: "var(--git-status-deleted)",
  renamed: "var(--git-status-modified)",
  untracked: "var(--git-status-added)",
  conflict: "var(--git-status-deleted)",
};

async function fetchGitStatus(cwd: string): Promise<GitStatusResponse> {
  const response = await fetch(`/api/git/status?${new URLSearchParams({ cwd }).toString()}`);
  if (!response.ok) throw new Error(`Failed to load Git status (HTTP ${response.status})`);
  return response.json() as Promise<GitStatusResponse>;
}

function ChangeRow({ status, cwd, onOpenFile }: {
  status: GitFileStatus;
  cwd: string;
  onOpenFile: Props["onOpenFile"];
}) {
  const [hovered, setHovered] = useState(false);
  const relativePath = getRelativeFilePath(status.filePath, cwd);

  return (
    <button
      type="button"
      onClick={() => onOpenFile(status.filePath, getFileName(status.filePath), { initialDisplayMode: "diff" })}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={status.filePath}
      style={{ width: "100%", display: "flex", alignItems: "center", gap: 4, padding: "0 5px", height: 24, border: "none", borderRadius: 4, background: hovered ? "var(--bg-hover)" : "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left" }}
    >
      <span style={{ width: 14, flexShrink: 0, color: GIT_STATUS_COLORS[status.status], fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600, textAlign: "center" }}>{status.code}</span>
      <span style={{ flexShrink: 0, display: "flex", alignItems: "center", opacity: 0.85 }}>{getFileIcon(getFileName(status.filePath), 13)}</span>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, fontSize: 12 }}>{relativePath}</span>
    </button>
  );
}

export function QuickChangesPanel({ cwd, refreshKey, onOpenFile }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  const [gitStatus, setGitStatus] = useState<GitStatusResponse | null>(null);
  const [gitLoading, setGitLoading] = useState(false);

  const loadGitStatus = useCallback(async () => {
    setGitLoading(true);
    try {
      setGitStatus(await fetchGitStatus(cwd));
    } catch {
      setGitStatus(null);
    } finally {
      setGitLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void loadGitStatus();
  }, [loadGitStatus, refreshKey]);

  useEffect(() => {
    setOpen(true);
  }, [cwd]);

  // 面板始终渲染（头部常驻），只在加载出错时（无响应且非加载中）静默隐藏。
  // 非 Git 仓库 / 无未提交变更时显示空状态文案，让功能可被发现。
  const changes = gitStatus?.files.reduce(
    (counts, file) => {
      if (file.status === "added" || file.status === "untracked") counts.added += 1;
      else if (file.status === "deleted" || file.status === "conflict") counts.deleted += 1;
      else counts.modified += 1;
      return counts;
    },
    { modified: 0, added: 0, deleted: 0 },
  ) ?? { modified: 0, added: 0, deleted: 0 };

  const isGitRepository = gitStatus?.isGitRepository ?? false;
  const noChanges = gitStatus !== null && isGitRepository && gitStatus.files.length === 0;
  const notGitRepository = gitStatus !== null && !isGitRepository;
  const loadFailed = gitStatus === null && !gitLoading;

  if (loadFailed) {
    return null;
  }

  return (
    <section
      style={{
        flex: "0 0 auto",
        minHeight: 0,
        borderTop: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0, padding: "6px 10px", background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", textAlign: "left" }}
        >
          <CaretRight size={9} weight="regular" style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }} aria-hidden="true" />
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("desktop.quickChanges")}</span>
        </button>
        <div
          className="git-changes-indicator"
          aria-label={`Changed files: ${changes.modified} modified, ${changes.added} added, ${changes.deleted} deleted`}
        >
          {changes.modified > 0 && <span className="git-changes-indicator-part git-changes-indicator-modified">{changes.modified}</span>}
          {changes.added > 0 && <span className="git-changes-indicator-part git-changes-indicator-added">{changes.added}</span>}
          {changes.deleted > 0 && <span className="git-changes-indicator-part git-changes-indicator-deleted">{changes.deleted}</span>}
        </div>
        <span style={{ marginLeft: 6, color: "var(--git-status-added)", fontFamily: "var(--font-mono)", fontSize: 11 }}>+{gitStatus?.additions ?? 0}</span>
        <span style={{ marginLeft: 5, color: "var(--git-status-deleted)", fontFamily: "var(--font-mono)", fontSize: 11 }}>-{gitStatus?.deletions ?? 0}</span>
        <button
          type="button"
          onClick={() => void loadGitStatus()}
          disabled={gitLoading}
          title={t("desktop.refresh")}
          aria-label={t("desktop.refresh")}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, marginLeft: 4, marginRight: 6, border: "none", borderRadius: 5, background: "none", color: "var(--text-dim)", cursor: gitLoading ? "wait" : "pointer", opacity: gitLoading ? 0.55 : 1 }}
        >
          {gitLoading ? <Spinner size={12} style={{ animation: "spin 0.8s linear infinite" }} aria-hidden="true" /> : <ArrowClockwise size={13} weight="regular" aria-hidden="true" />}
        </button>
      </div>
      {open && (
        <div style={{ minHeight: 0, maxHeight: "min(35vh, 280px)", overflowY: "auto", overflowX: "hidden", padding: "2px 4px 4px" }}>
          {notGitRepository && <EmptyState message={t("desktop.quickChangesNotGitRepository")} />}
          {noChanges && <EmptyState message={t("desktop.quickChangesNoChanges")} />}
          {gitStatus !== null && isGitRepository && gitStatus.files.map((status) => (
            <ChangeRow key={status.filePath} status={status} cwd={cwd} onOpenFile={onOpenFile} />
          ))}
        </div>
      )}
    </section>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: "8px 10px",
        fontSize: 12,
        color: "var(--text-dim)",
        fontStyle: "italic",
      }}
    >
      {message}
    </div>
  );
}
