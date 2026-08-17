/**
 * use-file-change-indicator — 文件变更指示（独立增量，可整体移除）
 *
 * 每 10 秒对当前预览文件做一次轻量 stat（后端 type=stat API，仅元数据：
 * mtime+size，不读内容、不涉及转换/COM、不影响任何外部进程）。
 *
 * 行为：
 *  - 打开文件 / 点击刷新（resetKey 变化）→ 重置基准并清除变色
 *  - 检测到文件被外部修改（mtime/size 与基准不同）→ 返回 true（刷新按钮变色提醒）
 *  - 用户点击刷新按钮后（resetKey 变化）→ 自动变回 false，并建立新基准
 */
import { useEffect, useRef, useState } from "react";
import { encodeFilePathForApi } from "@/lib/file-paths";

const POLL_INTERVAL_MS = 3_000;

export function useFileChangeIndicator(
  filePath: string | null | undefined,
  resetKey: unknown,
): boolean {
  const [changed, setChanged] = useState(false);
  const baseRef = useRef<{ mtimeMs: number; size: number } | null>(null);

  // 重置：新文件 / 刷新后 → 清除变色，重新建立基准
  useEffect(() => {
    baseRef.current = null;
    setChanged(false);
  }, [filePath, resetKey]);

  useEffect(() => {
    if (!filePath) return;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/files/${encodeFilePathForApi(filePath)}?type=stat`);
        if (!res.ok) return;
        const data: { mtimeMs?: number; size?: number } = await res.json();
        if (stopped || data.mtimeMs === undefined) return;
        if (!baseRef.current) {
          // 首次查询：仅建立基准，不变色
          baseRef.current = { mtimeMs: data.mtimeMs, size: data.size ?? 0 };
          return;
        }
        if (data.mtimeMs !== baseRef.current.mtimeMs || data.size !== baseRef.current.size) {
          setChanged(true);
        }
      } catch {
        // 网络/路径错误忽略（下个周期重试）
      }
    };
    void tick();
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [filePath]);

  return changed;
}
