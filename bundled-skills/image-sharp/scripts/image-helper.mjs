#!/usr/bin/env node
/**
 * image-helper.mjs — 图片处理封装（基于 sharp）
 *
 * 用法：
 *   node image-helper.mjs info <img>                    # 元数据
 *   node image-helper.mjs convert <in> <out> [options]  # 转换/缩放/压缩
 *   node image-helper.mjs batch <indir> <outdir> [options]  # 批量
 *   node image-helper.mjs watermark <in> <out> --text "水印"  # 文字水印
 *
 * options:
 *   --resize <px>      最长边（保持比例）
 *   --width <px> / --height <px>  精确尺寸
 *   --quality <0-100>  压缩质量（默认 80）
 *   --format <fmt>     输出格式（jpg/png/webp/avif）
 *   --rotate <deg>     旋转角度
 *   --text "水印文字"   叠加文字水印
 */
import sharp from "sharp";
import { readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const FORMATS = { jpg: "jpeg", jpeg: "jpeg", png: "png", webp: "webp", avif: "avif", gif: "gif", tiff: "tiff" };

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val !== undefined && !val.startsWith("--")) {
        opts[key] = val;
        i++;
      } else {
        opts[key] = true;
      }
    }
  }
  return opts;
}

function applyTransform(image, opts) {
  if (opts.rotate) image = image.rotate(parseInt(opts.rotate, 10));
  if (opts.resize) image = image.resize({ width: parseInt(opts.resize, 10), withoutEnlargement: true });
  if (opts.width) image = image.resize({ width: parseInt(opts.width, 10) });
  if (opts.height) image = image.resize({ height: parseInt(opts.height, 10) });
  return image;
}

export async function getInfo(file) {
  const meta = await sharp(file).metadata();
  return { width: meta.width, height: meta.height, format: meta.format, size: meta.size };
}

export async function convertImage(input, output, opts = {}) {
  let image = sharp(input);
  image = applyTransform(image, opts);
  if (opts.text) {
    const svg = Buffer.from(
      `<svg width="400" height="100"><rect width="400" height="100" fill="rgba(0,0,0,0.5)"/><text x="20" y="60" font-size="36" fill="white">${opts.text}</text></svg>`,
    );
    image = image.composite([{ input: svg, gravity: "southeast" }]);
  }
  if (!opts["keep-exif"]) image = image.withMetadata(false);
  const format = FORMATS[opts.format] ?? extname(output).slice(1);
  const quality = parseInt(opts.quality ?? "80", 10);
  if (format === "jpeg") image = image.jpeg({ quality, mozjpeg: true });
  else if (format === "webp") image = image.webp({ quality });
  else if (format === "avif") image = image.avif({ quality });
  else if (format === "png") image = image.png({ compressionLevel: 9 });
  else image = image.toFormat(format);
  await image.toFile(output);
  return output;
}

export async function batchConvert(inputDir, outputDir, opts = {}) {
  const files = readdirSync(inputDir).filter((f) => /\.(jpe?g|png|webp|avif|gif|tiff?)$/i.test(f));
  const results = [];
  for (const f of files) {
    const inPath = join(inputDir, f);
    if (!statSync(inPath).isFile()) continue;
    const fmt = opts.format ?? "webp";
    const outName = f.replace(/\.[^.]+$/, "") + "." + fmt;
    await convertImage(inPath, join(outputDir, outName), opts);
    results.push(outName);
  }
  return results;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  const [cmd, arg1, arg2, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  if (cmd === "info") {
    console.log(JSON.stringify(await getInfo(arg1), null, 2));
  } else if (cmd === "convert") {
    await convertImage(arg1, arg2, opts);
    console.log(`✅ 已生成 ${arg2}`);
  } else if (cmd === "batch") {
    const results = await batchConvert(arg1, arg2, opts);
    console.log(`✅ 批量完成 ${results.length} 个文件: ${results.join(", ")}`);
  } else {
    console.error("用法: image-helper.mjs info|convert|batch|watermark ...");
    process.exit(1);
  }
}
