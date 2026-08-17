# Bundled Skills 来源与许可清单（SBOM）

> 生成日期：2026-08-12
> 用途：内网部署供应链可查证。每个 skill 的来源、许可、版本、本地适配说明。

## 技能清单

| Skill | 来源 | 许可 | 版本/来源日期 | 本地适配说明 |
| --- | --- | --- | --- | --- |
| office-viewer | 本项目内置（随应用工具） | MIT（本项目） | — | 使用应用内置 read_word/read_spreadsheet/read_pdf |
| pdf | 本项目内置 | MIT（本项目） | — | 读取走内置 read_pdf；创建/编辑能力由 pdf-tools 补充 |
| windows-word-docx | 本项目内置 | MIT（本项目） | — | PowerShell 生成 DOCX，离线可用 |
| guizang-ppt-skill | [op7418/guizang-ppt-skill](https://github.com/op7418/guizang-ppt-skill)（第三方） | **AGPL-3.0** ⚠️ | 2026-08-05 | 路径本地化（Windows 便携）；**字体/图标需本地化（构建前适配中）** |
| office-excel | 本项目封装 | MIT | exceljs 4.4.0（MIT） | 基于 exceljs；图表不支持（引导手动） |
| office-pptx | 本项目封装 | MIT | pptxgenjs 4.0.1（MIT） | 基于 pptxgenjs；原生 .pptx 生成 |
| image-sharp | 改编自 [terminal-skills](https://terminalskills.io/skills/sharp) | Apache-2.0 | sharp ^0.34（Apache-2.0） | 缩放/转换/压缩/水印/批处理 |
| pdf-tools | 移植自 [HybridAIOne/hybridclaw](https://github.com/HybridAIOne/hybridclaw) skills/pdf | MIT | pdf-lib 1.17（MIT）、pdfjs-dist 5.7.284（Apache-2.0） | 中文适配：内置 Noto Sans SC 常用字子集（GB2312 一级，1.9MB，OFL 许可）自动嵌入 |
| office-email | 移植自 [netease-youdao/LobsterAI](https://github.com/netease-youdao/LobsterAI) SKILLs/imap-smtp-email | 官方标记（仓库内 LICENSE 为准） | v1.0.7 | 配置本地化（accounts.json/.env，原为 LobsterAI 设置面板）；依赖 nodemailer/imap-simple/mailparser（MIT） |
| mermaid-diagrams | 改编自 [Agents365-ai/mermaid-skill](https://github.com/Agents365-ai/mermaid-skill) | MIT | 2026-08-12 | 渲染出口本地化：前端 mermaid（内置 mermaid 11.16，MIT）；不再依赖 mmdc/Kroki |

## ⚠️ 合规提示

1. **guizang-ppt-skill 为 AGPL-3.0**：AGPL 要求基于其代码的修改版在提供网络服务时开放源码。本项目为**内网离线部署**（不对外提供网络服务、不对外分发修改版），AGPL 传染风险较低；但若未来对外分发或提供 SaaS 服务，需重新评估或替换该 skill。
2. **office-email 许可**：来源仓库（netease-youdao/LobsterAI）为官方标记 skill，仓库未标注明确开源许可文件——已随包保留其 LICENSE/README 原文备查；如需对外分发请与来源方确认。
3. 其余 skill 及依赖均为 MIT / Apache-2.0 / OFL（字体），可自由打包分发。

## 依赖许可速查（新增 10 个）

| 依赖 | 许可 | 用途 |
| --- | --- | --- |
| exceljs | MIT | Excel 读写 |
| pptxgenjs | MIT | PPT 生成 |
| sharp | Apache-2.0 | 图片处理 |
| pdf-lib | MIT | PDF 创建/编辑/表单 |
| @pdf-lib/fontkit | MIT | PDF 字体嵌入 |
| pdfjs-dist | Apache-2.0 | PDF 文本提取/渲染 |
| nodemailer | MIT | SMTP 发信 |
| imap-simple | MIT | IMAP 收信 |
| mailparser | MIT | 邮件解析 |
| imap | MIT | IMAP 底层 |
| dotenv | BSD-2-Clause | 配置加载 |
| Noto Sans SC（子集） | OFL-1.1 | PDF 中文字体 |
