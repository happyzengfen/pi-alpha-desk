/**
 * PdfViewer — PDF/PPTX 预览（连续滚动 + 页号跳转 + 刷新停留）
 *
 * - 加载策略：全量加载（打开即渲染全部页面，滚动浏览）
 * - 顶栏：`[当前页] / 总页数`，当前页为可编辑输入框，回车/失焦跳转到指定页
 * - 刷新：点击刷新后停留在原页（页数变化时钳制）
 * - 切换文件：重置滚动位置到第一页
 */
import { useCallback, useEffect, useMemo, useLayoutEffect, useRef, useState } from "react";
import { useFileChangeIndicator } from "@/hooks/use-file-change-indicator";

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
const btnActive: React.CSSProperties = {
  ...btnBase,
  color: "var(--accent, #4f8cff)",
  borderColor: "var(--accent, #4f8cff)",
};

export function PdfViewer({
  url,
  fileName,
  filePath,
}: {
  url: string;
  fileName: string;
  filePath?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const currentPageRef = useRef(1);
  const pendingRestoreScroll = useRef<number | null>(null);
  const recomputeRef = useRef<(() => void) | null>(null);
  const inputFocusedRef = useRef(false);
  const [refreshTick, setRefreshTick] = useState(0);
  // 文件变更指示（独立增量：可整体移除——删除本行 + 刷新按钮变色样式即可）
  const fileChanged = useFileChangeIndicator(filePath, refreshTick);
  const [containerWidth, setContainerWidth] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLSpanElement>(null); // W1 页号/总数
  const refreshRef = useRef<HTMLButtonElement>(null); // W2 刷新
  const fitWidthRef = useRef<HTMLButtonElement>(null); // W3 适应宽度
  const zoomRef = useRef<HTMLSpanElement>(null); // W4 缩放区（− % ＋）
  const [showZoomControls, setShowZoomControls] = useState(true);
  const showZoomRef = useRef(true); // 缩放区显示状态（唯一状态源，只由两个比较改变）
  const w01Ref = useRef(0); // 四部分全宽：W1+W2+W3+W4+56（打开文件时测量一次，固定）
  // 固定开销：3 个间距(8px) + 左右内边距(16px×2) = 56；隐藏后为 2 个间距 + 32 = 48
  const FIXED_FULL = 56;
  // 阈值：w0 < w01+30 → 隐藏；w0 > w01+50 → 显示（30~50 之间为滞回区，状态不变）
  const HIDE_THRESHOLD = 30;
  const SHOW_THRESHOLD = 50;
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [pageInput, setPageInput] = useState("1");
  const [fitWidth, setFitWidth] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const PAGE_GAP = 16; // 页间距（渲染区 gap）
  const CONTENT_PADDING = 16; // 内容区顶部 padding
  // 固定页高：程序定值（与渲染同一公式），不依赖图片加载
  const pageHeight = useMemo(() => {
    if (!naturalSize) return 0;
    const ratio = naturalSize.h / naturalSize.w;
    const baseWidth = fitWidth ? (containerWidth || 800) : naturalSize.w * zoom;
    return baseWidth * ratio;
  }, [naturalSize, fitWidth, zoom, containerWidth]);
  const pageStep = pageHeight + PAGE_GAP;

  const pageUrlFor = useCallback(
    (page: number) => {
      const u = new URL(url, window.location.origin);
      u.searchParams.set("type", "pdfpage");
      u.searchParams.set("page", String(page));
      // refreshTick 变化 → URL 变化 → 浏览器绕过缓存重新请求（配合刷新按钮）
      u.searchParams.set("v", String(refreshTick));
      return u.toString();
    },
    [url, refreshTick],
  );

  const updateCurrentPage = useCallback((page: number) => {
    setCurrentPage(page);
    currentPageRef.current = page;
    if (!inputFocusedRef.current) setPageInput(String(page));
  }, []);

  /** 滚动到指定页（等待该页渲染后定位） */
  const scrollToPage = useCallback((target: number) => {
    const el = containerRef.current;
    if (!el) return;
    let attempts = 0;
    const tryScroll = () => {
      const node = pageRefs.current[target - 1];
      if (node && node.offsetTop > 0) {
        // 用 getBoundingClientRect 相对滚动容器精确定位（避免 offsetParent 偏差/顶栏遮挡）
        const rect = node.getBoundingClientRect();
        const containerRect = el.getBoundingClientRect();
        el.scrollTo({ top: el.scrollTop + (rect.top - containerRect.top) });
        return;
      }
      attempts += 1;
      if (attempts < 30) setTimeout(tryScroll, 100);
    };
    tryScroll();
  }, []);

  /** 跳转到指定页（输入框/恢复位置共用） */
  const goToPage = useCallback(
    (raw: number) => {
      if (!pageCount) return;
      const target = Math.min(Math.max(1, Math.round(raw)), pageCount);
      updateCurrentPage(target);
      scrollToPage(target);
    },
    [pageCount, updateCurrentPage, scrollToPage],
  );

  // 打开文件（url/pageCount 变化）或缩放区恢复显示后：测量一次 W1~W4 并记录 w01。
  // 四部分宽度固定 → 记录后保持不变，判断只用加法比较。
  useLayoutEffect(() => {
    if (!showZoomControls) return; // 缩放区未显示时测不到 W4，等显示后再测
    const w1 = pageRef.current?.offsetWidth ?? 0;
    const w2 = refreshRef.current?.offsetWidth ?? 0;
    const w3 = fitWidthRef.current?.offsetWidth ?? 0;
    const w4 = zoomRef.current?.offsetWidth ?? 0;
    if (w1 > 0 && w2 > 0 && w3 > 0 && w4 > 0) {
      w01Ref.current = w1 + w2 + w3 + w4 + FIXED_FULL;
    }
  }, [showZoomControls, url, pageCount]);

  // 功能栏宽度 w0 监听：唯一能改变缩放区显示/隐藏状态的两个比较。
  // 换文件时重置状态为显示（保证能重新测量 W4）。
  useEffect(() => {
    w01Ref.current = 0; // 新文件：清空旧测量值，等重测
    showZoomRef.current = true;
    setShowZoomControls(true);
  }, [url]);

  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const check = () => {
      const w0 = el.clientWidth;
      if (w01Ref.current <= 0) return; // 还没测到固定值，先不做判断
      if (showZoomRef.current) {
        if (w0 < w01Ref.current + HIDE_THRESHOLD) {
          showZoomRef.current = false;
          setShowZoomControls(false);
        }
      } else if (w0 > w01Ref.current + SHOW_THRESHOLD) {
        showZoomRef.current = true;
        setShowZoomControls(true);
      }
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 监听容器宽度（fitWidth 模式下页高依赖容器宽）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 刷新前记录像素滚动位置（refreshTick 变化时）——刷新后按原像素恢复，不做页顶对齐
  useEffect(() => {
    if (refreshTick > 0) {
      pendingRestoreScroll.current = containerRef.current?.scrollTop ?? null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  // 探测：页数/尺寸（url/refreshTick 变化时重新探测；切换文件重置滚动位置）
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPageCount(0);
    setNaturalSize(null);
    setError(null);
    updateCurrentPage(1);
    // 切换文件/刷新：先回到顶部（刷新后由恢复逻辑重新定位）
    containerRef.current?.scrollTo(0, 0);
    fetch(pageUrlFor(1))
      .then((r) => {
        if (!r.ok) {
          // 501 = 转换器不可用；423 = 文件被其他程序占用
          if (r.status === 501) {
            throw new Error("当前机器缺少 WPS 或 Microsoft PowerPoint，无法预览 PPT");
          }
          if (r.status === 423) {
            throw new Error("文件可能正被其他程序使用（如 PowerPoint/WPS），请关闭后点击刷新重试");
          }
          throw new Error(`HTTP ${r.status}`);
        }
        const count = Number(r.headers.get("X-PDF-PageCount"));
        const w = Number(r.headers.get("X-PDF-Width"));
        const h = Number(r.headers.get("X-PDF-Height"));
        if (!cancelled) {
          if (count) {
            // 全量加载：打开即渲染全部页面
            setPageCount(count);
            // 刷新后恢复原像素位置（固定页高 → 页面 div 高度立即可知；超出新内容范围时钳制）
            const restore = pendingRestoreScroll.current;
            pendingRestoreScroll.current = null;
            if (restore !== null && restore > 0) {
              setTimeout(() => {
                const el = containerRef.current;
                if (!el) return;
                const max = Math.max(el.scrollHeight - el.clientHeight, 0);
                el.scrollTo({ top: Math.min(restore, max) });
                recomputeRef.current?.();
              }, 50);
            }
          }
          if (w && h) setNaturalSize({ w, h });
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pageUrlFor, updateCurrentPage, scrollToPage]);

  // 重新计算当前页：视口内可见面积最大的页（固定页高纯计算，不依赖图片/几何；
  // 面积相同（严格大于比较）时保留先遍历到的页 = 页码更小者，即优先上方页）
  const recomputeCurrentPage = useCallback(() => {
    const el = containerRef.current;
    if (!el || pageHeight <= 0 || pageCount === 0) return;
    // 兜底：拉到最顶部 → 第 1 页
    if (el.scrollTop <= 1) {
      if (currentPageRef.current !== 1) updateCurrentPage(1);
      return;
    }
    const viewTop = el.scrollTop;
    const viewBottom = el.scrollTop + el.clientHeight;
    let bestPage = currentPageRef.current;
    let bestVisible = -1;
    for (let i = 0; i < pageCount; i += 1) {
      const pageTop = CONTENT_PADDING + i * pageStep;
      const pageBottom = pageTop + pageHeight;
      const visible = Math.min(pageBottom, viewBottom) - Math.max(pageTop, viewTop);
      if (visible > 0 && visible > bestVisible) {
        bestVisible = visible;
        bestPage = i + 1;
      }
    }
    if (bestPage !== currentPageRef.current) updateCurrentPage(bestPage);
  }, [pageCount, pageHeight, pageStep, updateCurrentPage]);

  // 保持 recomputeRef 始终指向最新实现（供 setTimeout 恢复回调调用）
  recomputeRef.current = recomputeCurrentPage;

  // 滚动：重新计算当前页
  const onScroll = useCallback(() => {
    recomputeCurrentPage();
  }, [recomputeCurrentPage]);

  const imgWidth = useMemo(() => {
    if (!naturalSize) return undefined;
    if (fitWidth) return "100%";
    return `${Math.round(naturalSize.w * zoom)}px`;
  }, [naturalSize, fitWidth, zoom]);

  // 显示缩放比例：fitWidth 时 = 实际渲染比例（容器宽 ÷ 页面原始宽），非固定 100%
  const displayPercent = useMemo(() => {
    if (!naturalSize) return Math.round((fitWidth ? 1 : zoom) * 100);
    if (fitWidth) {
      const available = Math.max((containerWidth || 800) - 32, 50); // 容器内容宽（去掉左右 padding）
      return Math.round((available / naturalSize.w) * 100);
    }
    return Math.round(zoom * 100);
  }, [naturalSize, fitWidth, zoom, containerWidth]);

  // 加减：以当前实际显示值（含适应宽度下的真实比例）为基准，跳到最近的 20% 倍数
  const zoomIn = useCallback(() => {
    const current = displayPercent;
    const target = Math.min(400, (Math.floor(current / 20) + 1) * 20); // 严格向上取 20 倍数
    setFitWidth(false);
    setZoom(target / 100);
  }, [displayPercent]);
  const zoomOut = useCallback(() => {
    const current = displayPercent;
    const target = Math.max(20, (Math.ceil(current / 20) - 1) * 20); // 严格向下取 20 倍数
    setFitWidth(false);
    setZoom(target / 100);
  }, [displayPercent]);

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        const n = Number.parseInt(pageInput, 10);
        if (Number.isFinite(n)) goToPage(n);
        else setPageInput(String(currentPageRef.current));
      }
    },
    [pageInput, goToPage],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* 顶栏：页号跳转 + 缩放 */}
      <div
        ref={barRef}
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
        <span ref={pageRef} style={{ display: "flex", alignItems: "center", gap: 4, fontFamily: "var(--font-mono)", flexShrink: 0 }}>
          <input
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ""))}
            onKeyDown={handleInputKeyDown}
            onBlur={() => {
              inputFocusedRef.current = false;
              const n = Number.parseInt(pageInput, 10);
              if (Number.isFinite(n) && n > 0) goToPage(n);
              else setPageInput(String(currentPageRef.current));
            }}
            onFocus={() => {
              inputFocusedRef.current = true;
            }}
            disabled={!pageCount}
            title="输入页码后回车跳转"
            style={{
              width: 44,
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text)",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              padding: "2px 6px",
              textAlign: "center",
              outline: "none",
            }}
          />
          <span>/</span>
          <span>{pageCount || "–"}</span>
          <span style={{ marginLeft: 4 }}>页</span>
        </span>
        <button
          ref={refreshRef}
          onClick={() => setRefreshTick((t) => t + 1)}
          style={
            fileChanged
              ? { ...btnBase, flexShrink: 0, color: "var(--accent, #4f8cff)", borderColor: "var(--accent, #4f8cff)" }
              : { ...btnBase, flexShrink: 0 }
          }
          title="刷新预览（重新读取文件；不会影响正在使用的 PowerPoint/WPS）"
        >
          ⟳ 刷新
        </button>
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <button ref={fitWidthRef} onClick={() => setFitWidth(true)} style={fitWidth ? btnActive : btnBase} title="适应宽度">
            适应宽度
          </button>
          {showZoomControls && (
            <span ref={zoomRef} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button onClick={zoomOut} style={btnBase} title="缩小">
                −
              </button>
              <span style={{ fontFamily: "var(--font-mono)", minWidth: 44, textAlign: "center" }}>
                {displayPercent}%
              </span>
              <button onClick={zoomIn} style={btnBase} title="放大">
                ＋
              </button>
            </span>
          )}
        </span>
      </div>
      {/* 连续滚动区 */}
      <div
        ref={containerRef}
        onScroll={onScroll}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          position: "relative",
          background: "var(--bg-panel)",
          padding: "16px 16px 32px",
        }}
      >
        {loading && !error ? (
          <div style={{ marginTop: 48, color: "var(--text-dim)", fontSize: 13, textAlign: "center" }}>
            正在更新预览…
          </div>
        ) : error ? (
          <div style={{ marginTop: 48, color: "#f87171", fontSize: 13, textAlign: "center", maxWidth: 480 }}>
            无法预览：{error}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
            {Array.from({ length: pageCount }, (_, index) => (
              <div
                key={`${index + 1}-${refreshTick}`}
                ref={(el) => {
                  pageRefs.current[index] = el;
                }}
                style={{ width: "100%", display: "flex", justifyContent: "center" }}
              >
                <img
                  src={pageUrlFor(index + 1)}
                  alt={`${fileName} 第 ${index + 1} 页`}
                  onLoad={recomputeCurrentPage}
                  style={{
                    width: imgWidth,
                    height: pageHeight || undefined,
                    maxWidth: "none",
                    background: "#ffffff",
                    boxShadow: "0 2px 14px rgba(0,0,0,0.4)",
                    borderRadius: 2,
                    flexShrink: 0,
                  }}
                />
              </div>
            ))}
            {pageCount > 0 && (
              <div style={{ padding: "8px 0", fontSize: 11, color: "var(--text-dim)" }}>
                — 已到末尾（共 {pageCount} 页）—
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
