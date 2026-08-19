/**
 * PreviewToolbar — 简易预览功能栏（独立增量，可整体移除）
 *
 * 给非 PDF 渲染的预览（表格 iframe / 文本 / 图片）提供与 PdfViewer 一致的功能栏：
 *  - 左侧：刷新按钮（可选——图片预览不提供）
 *  - 右侧：适应宽度 + 大小调整（− / 百分比 / ＋，20% 步进）
 *  - 3 秒文件变更检测：文件被外部修改 → 刷新按钮变色提醒（与 PdfViewer 同款）
 *
 * 缩放/适应宽度由父组件通过 onViewChange 应用到内容（transform/字体/宽度）。
 */
import { useCallback, useRef, useState } from "react";
import { useFileChangeIndicator } from "@/hooks/use-file-change-indicator";
import { useI18n } from "@/hooks/useI18n";

const btnBase: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 4,
  color: "var(--text-dim)",
  padding: "2px 10px",
  fontSize: 11,
  cursor: "pointer",
  fontFamily: "var(--font-sans)",
  flexShrink: 0,
  whiteSpace: "nowrap",
};

export interface PreviewViewState {
  fitWidth: boolean;
  zoom: number;
}

export function PreviewToolbar({
  filePath,
  showRefresh = true,
  onRefresh,
  onViewChange,
}: {
  filePath: string;
  showRefresh?: boolean;
  onRefresh: () => void;
  onViewChange: (view: PreviewViewState) => void;
}) {
  const { t } = useI18n();
  const [fitWidth, setFitWidth] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [refreshTick, setRefreshTick] = useState(0);
  const changed = useFileChangeIndicator(showRefresh ? filePath : null, refreshTick);
  const lastViewRef = useRef<PreviewViewState>({ fitWidth: true, zoom: 1 });

  const emit = useCallback(
    (next: PreviewViewState) => {
      lastViewRef.current = next;
      onViewChange(next);
    },
    [onViewChange],
  );

  const zoomIn = useCallback(() => {
    const target = Math.min(4, (Math.floor(zoom / 0.2) + 1) * 0.2);
    setFitWidth(false);
    setZoom(target);
    emit({ fitWidth: false, zoom: target });
  }, [zoom, emit]);

  const zoomOut = useCallback(() => {
    const target = Math.max(0.2, (Math.ceil(zoom / 0.2) - 1) * 0.2);
    setFitWidth(false);
    setZoom(target);
    emit({ fitWidth: false, zoom: target });
  }, [zoom, emit]);

  const handleFitWidth = useCallback(() => {
    setFitWidth(true);
    setZoom(1);
    emit({ fitWidth: true, zoom: 1 });
  }, [emit]);

  const handleRefresh = useCallback(() => {
    setRefreshTick((t) => t + 1);
    onRefresh();
  }, [onRefresh]);

  const percent = Math.round(zoom * 100);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 16px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg)",
        fontSize: 11,
        color: "var(--text-dim)",
        flexShrink: 0,
        flexWrap: "nowrap",
        overflow: "hidden",
      }}
    >
      {showRefresh && (
        <button
          onClick={handleRefresh}
          style={
            changed
              ? { ...btnBase, color: "var(--accent, #4f8cff)", borderColor: "var(--accent, #4f8cff)" }
              : btnBase
          }
          title={t("desktop.refreshPreviewTitle")}
        >
          ⟳ {t("desktop.refresh")}
        </button>
      )}
      <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        <button onClick={handleFitWidth} style={fitWidth ? { ...btnBase, color: "var(--accent, #4f8cff)", borderColor: "var(--accent, #4f8cff)" } : btnBase} title={t("desktop.fitWidth")}>
          {t("desktop.fitWidth")}
        </button>
        <button onClick={zoomOut} style={btnBase} title={t("desktop.zoomOut")}>
          −
        </button>
        <span style={{ fontFamily: "var(--font-mono)", minWidth: 44, textAlign: "center" }}>{percent}%</span>
        <button onClick={zoomIn} style={btnBase} title={t("desktop.zoomIn")}>
          ＋
        </button>
      </span>
    </div>
  );
}
