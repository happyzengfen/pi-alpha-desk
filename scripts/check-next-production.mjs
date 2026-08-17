#!/usr/bin/env node
/**
 * check-next-production.mjs — 打包前校验 .next 为干净的 production build
 *
 * 背景：v7 曾因 .next 被 next dev（源码目录测试）污染导致安装包缺失最新代码
 * （pptx 预览分支、md 5MB 上限等）。本脚本在打包前快速校验关键特征，
 * 不通过则拒绝继续，避免再次打包出残缺产物。
 *
 * 用法：node scripts/check-next-production.mjs   （在项目根执行）
 * 退出码：0=通过；1=不通过（阻止打包）
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const NEXT = join(ROOT, ".next");
const CHUNKS = join(NEXT, "static", "chunks", "app");
const ROUTE = join(NEXT, "server", "app", "api", "files", "[...path]", "route.js");

const failures = [];

// 1. BUILD_ID 必须存在且非空（dev 模式会缺失/为空）
const buildIdPath = join(NEXT, "BUILD_ID");
const buildId = existsSync(buildIdPath) ? readFileSync(buildIdPath, "utf8").trim() : "";
if (!buildId) failures.push("BUILD_ID 缺失/为空（.next 可能为 dev 缓存或未构建）");

// 2. 前端必须包含 pptx 预览分支（FileViewer isPptx）
const chunks = existsSync(CHUNKS) ? readdirSync(CHUNKS).filter((f) => f.endsWith(".js")) : [];
const hasPptxFrontend = chunks.some((f) => readFileSync(join(CHUNKS, f), "utf8").includes("pptx"));
if (!hasPptxFrontend) failures.push("前端 bundle 缺少 pptx 预览分支（代码未编译进 .next）");

// 3. 后端 route 必须支持 pdfpage（含 pptx 转换分支）
const routeText = existsSync(ROUTE) ? readFileSync(ROUTE, "utf8") : "";
if (!routeText.includes("pdfpage")) failures.push("后端缺少 pdfpage 端点");
if (!routeText.includes("pptx")) failures.push("后端缺少 pptx 转换分支");

if (failures.length > 0) {
  console.error("❌ .next 校验失败，禁止打包：");
  failures.forEach((f) => console.error("   - " + f));
  console.error("   请先执行 npm run build（next build --webpack）后重试。");
  process.exit(1);
}
console.log(`✅ .next 校验通过（BUILD_ID=${buildId}，可打包）`);
