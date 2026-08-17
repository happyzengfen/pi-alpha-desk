#!/usr/bin/env node
/**
 * pptx-helper.mjs — PPT 生成封装（基于 pptxgenjs，随应用打包）
 *
 * 用法：
 *   node pptx-helper.mjs create <out.pptx> '<spec JSON>'
 *
 * spec 结构：
 * {
 *   "wide": true,                        // 16:9（默认）；false=4:3
 *   "title": "月度销售报告",             // 标题页标题（可选）
 *   "subtitle": "2026年8月",             // 标题页副标题（可选）
 *   "slides": [
 *     { "title": "要点页", "bullets": ["要点1", "要点2"] },
 *     { "title": "数据图表", "chart": { "type": "bar", "title": "销售额与成本",
 *        "series": [{"name":"销售额","labels":["1月","2月","3月"],"values":[120,150,130]}] } },
 *     { "title": "要点+图表", "bullets": [...], "chart": {...} }   // 可组合
 *   ]
 * }
 */
import pptxgen from "pptxgenjs";

const THEME = { primary: "4472C4", text: "333333", sub: "888888" };

/** 按规格生成 PPTX */
export async function createPptx(spec, outPath) {
  const pptx = new pptxgen();
  if (spec.wide !== false) {
    pptx.defineLayout({ name: "WIDE", width: 13.33, height: 7.5 });
    pptx.layout = "WIDE";
  } else {
    pptx.defineLayout({ name: "STAND", width: 10, height: 7.5 });
    pptx.layout = "STAND";
  }

  // 标题页
  if (spec.title) {
    const s = pptx.addSlide();
    s.background = { color: "F5F7FA" };
    s.addText(spec.title, {
      x: 1, y: 2.2, w: 11.3, h: 1.2, fontSize: 40, bold: true, color: THEME.primary, align: "center",
    });
    if (spec.subtitle) {
      s.addText(spec.subtitle, { x: 1, y: 3.6, w: 11.3, h: 0.8, fontSize: 20, color: THEME.sub, align: "center" });
    }
  }

  // 内容页
  for (const slide of spec.slides ?? []) {
    const s = pptx.addSlide();
    let y = 0.5;
    if (slide.title) {
      s.addText(slide.title, { x: 0.7, y, w: 12, h: 0.7, fontSize: 28, bold: true, color: THEME.text });
      y += 0.9;
      s.addShape(pptx.ShapeType.line, { x: 0.7, y, w: 12, h: 0, line: { color: THEME.primary, width: 2 } });
      y += 0.3;
    }
    if (slide.bullets?.length) {
      s.addText(
        slide.bullets.map((b) => ({ text: b, options: { bullet: { code: "2022" }, breakLine: true, fontSize: 18, color: THEME.text } })),
        { x: 0.9, y, w: 11.5, h: Math.max(1, slide.bullets.length * 0.5), valign: "top" },
      );
      y += slide.bullets.length * 0.55;
    }
    if (slide.chart) {
      const c = slide.chart;
      const opts = {
        x: 0.8, y: y + 0.2, w: 11.5, h: Math.max(3, 7.2 - y - 0.4),
        showTitle: true, title: c.title ?? "", titleColor: THEME.text, titleFontSize: 16,
        showLegend: true, legendPos: "b", dataLabelColor: THEME.sub, dataLabelFontSize: 10,
      };
      s.addChart(c.type ?? "bar", c.series, opts);
    }
  }

  await pptx.writeFile({ fileName: outPath });
  return outPath;
}

// CLI 入口
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  const [cmd, out, specJson] = process.argv.slice(2);
  if (cmd === "create") {
    const spec = JSON.parse(specJson ?? "{}");
    await createPptx(spec, out);
    console.log(`✅ 已生成 ${out}`);
  } else {
    console.error("用法: pptx-helper.mjs create <out.pptx> '<spec JSON>'");
    process.exit(1);
  }
}
