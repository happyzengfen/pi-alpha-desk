---
name: office-pptx
description: "创建和编辑 PowerPoint 演示文稿（.pptx）：生成演示幻灯片（文本、标题、要点列表）、插入图表（柱状/折线/饼图等）、形状、图片、自定义版式与主题配色。用户需要制作 PPT/演示文稿/幻灯片/汇报材料时使用。触发词：ppt、pptx、演示文稿、幻灯片、slides、汇报材料。"
license: MIT
type: actionable
---

# Office PPTX 生成（node 生态）

基于 **PptxGenJS**（node 库，已随应用打包）生成 .pptx 演示文稿。纯 node 实现，无 Python 依赖，离线可用。生成的文件可在 PowerPoint / WPS 中打开编辑。

## 环境

- 依赖：`pptxgenjs`（已随本 skill 自带，scripts/../node_modules，离线可用）
- 脚本：`scripts/pptx-helper.mjs` 提供常用生成函数，可直接 import 使用

## 核心能力

| 能力 | 支持 | 说明 |
| --- | --- | --- |
| 创建演示文稿 | ✅ | 自定义版式（16:9 / 4:3 / 自定义尺寸） |
| 文本与排版 | ✅ | 标题、正文、要点列表、字号/颜色/对齐/换行 |
| 图表 | ✅ | 柱状、折线、饼图、条形、面积等（带数据系列） |
| 形状 | ✅ | 矩形/圆形/箭头等 ShapeType，填充/线条/阴影 |
| 图片 | ✅ | 插入本地图片（PNG/JPG） |
| 表格 | ✅ | 在幻灯片中插入数据表格 |
| 主题与配色 | ✅ | 每页元素可指定颜色；自定义背景 |

## 工作流

### 1. 明确结构
先向用户确认：页数/章节结构、每页要点、需要的数据图表（数据从哪来）。

### 2. 编写脚本（参考 pptx-helper.mjs）
- 定义版式（推荐 16:9 WIDE）：`pptx.defineLayout({name:"WIDE",width:13.33,height:7.5}); pptx.layout="WIDE"`
- 逐页构建：标题页 → 目录页 → 内容页（要点）→ 数据图表页 → 结尾页
- 排版规范：
  - 字号：标题 28–40，正文 16–20，注释 12–14
  - 颜色：使用统一主题色（如企业色 #4472C4），正文深灰 #333
  - 对齐：标题居中或左对齐统一；元素位置使用坐标（英寸）
- 图表：`slide.addChart(type, dataSeries, options)`，数据系列 `{name, labels, values}`

### 3. 生成并验证
- 输出 .pptx 后**读回验证**（用 office-viewer 或 node 解包检查 slide XML），确认页数、文本、图表正确
- 告知用户文件路径

## 参考脚本用法

```bash
# 按 JSON 规格生成 PPT（含文本/图表/形状）
node scripts/pptx-helper.mjs create out.pptx '<spec JSON>'
```

spec 结构（详见 `scripts/pptx-helper.mjs` 注释）：`{"title":"...","subtitle":"...","wide":true,"slides":[{"title":"...","bullets":[...]},{"chart":{"type":"bar","title":"...","series":[...]}}]}`

## 与 office-excel 的分工

- 用户要**数据表格/报表** → `office-excel`
- 用户要**演示/汇报幻灯片** → `office-pptx`
- 用户要**网页翻页 PPT** → `guizang-ppt-skill`
