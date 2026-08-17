---
name: image-sharp
description: "处理图片：缩放、裁剪、旋转、格式转换（JPEG/PNG/WebP/AVIF/GIF/TIFF）、压缩、生成缩略图、加水印、批量处理、读取元数据。用户在需要处理图片（压缩、改尺寸、转换格式、加水印、批量处理）时使用。触发词：图片、图像、resize、缩放、压缩、转换格式、webp、缩略图、水印、批量图片。"
license: Apache-2.0
compatibility: 'Node.js 18+ (Linux, macOS, Windows)'
type: actionable
---

# Image Processing（基于 Sharp）

基于 **sharp**（Node 最快的图片处理库，底层 libvips）处理图片。纯 node 实现，随应用打包，离线可用。

## 环境

- 依赖：`sharp`（已随本 skill 自带，scripts/../node_modules，离线可用）
- 脚本：`scripts/image-helper.mjs` 提供常用操作封装，可直接 import 或参考写法

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 缩放/裁剪/旋转 | resize（含按比例）、extract 裁剪、rotate/翻转 |
| 格式转换 | JPEG / PNG / WebP / AVIF / GIF / TIFF |
| 压缩优化 | quality / mozjpeg / 网页图片优化 |
| 缩略图/响应式 | 多尺寸生成 |
| 水印/合成 | 文字水印（SVG 合成）、图片叠加 |
| 批量处理 | 目录循环批量转换 |
| 元数据 | 读取尺寸/格式/EXIF；可剥离（隐私）|

## 工作流

1. 明确需求：输入文件、目标（尺寸/格式/质量/水印）、输出路径
2. 用 `image-helper.mjs` 或直接写 sharp 脚本
3. 关键规范：
   - 压缩图片：`quality` 75-85（WebP/JPEG）；转换前确认目标格式
   - 批量处理：遍历目录，输出到 `output/` 子目录
   - 涉及隐私：默认剥离 EXIF（`withMetadata(false)`）
4. 验证：检查输出文件尺寸/格式/大小是否符合预期

## 参考脚本用法

```bash
# 缩放 + 转 WebP（质量 80）
node scripts/image-helper.mjs convert in.png out.webp --resize 800 --quality 80

# 批量转换目录下所有图片
node scripts/image-helper.mjs batch ./input ./output --format webp --quality 80

# 读取图片元数据
node scripts/image-helper.mjs info in.jpg
```

详见 `scripts/image-helper.mjs` 内部注释。
