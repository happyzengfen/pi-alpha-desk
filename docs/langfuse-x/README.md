# Langfuse：X 平台资料归档

> 归档日期：2026-08-07。用户输入的 `langfure` 按项目名 **Langfuse** 处理。

本目录收录从 X 平台发现的 Langfuse 高相关资料。优先保留完整 X Article；普通帖子则连同帖子明确指向的 Langfuse 官方文档一起归档。每条资料均含：

- `article.md`：可检索的 Markdown；
- `article.html`：可离线浏览的 HTML；
- `source.json`：原始 X API 响应与归档元数据；
- `images/`：下载成功的原文图片。

## 推荐阅读顺序

1. [Yes, you can copy our eval setup](./2079939078087188874/article.md) — 先看完整 AI engineering loop 与可复制的 chatbot eval setup。
2. [Scoping and curating eval datasets](./2085381643687047434/article.md) — 再学习如何定义、抽样和迭代评测数据集。
3. [Good evals are boring](./2085161454668513642/article.md) — 接着设计可靠 evaluator，并校准 LLM-as-a-judge。
4. [OpenTelemetry-native tracing with Langfuse](./2080280718836367816/article.md) — 然后接入 OpenTelemetry tracing。
5. [Tracing agent memory operations in Langfuse with EverOS](./2085292697074438505/article.md) — 参考 Agent Memory 的可观测性案例。
6. [Manage Langfuse dashboards via API, CLI, and MCP](./2079863575007420562/article.md) — 最后了解 Dashboard API、CLI 与 MCP 自动化。

## 全部条目

### Scoping and curating eval datasets

如何先定义评测数据集的目标，再从最小可用数据集逐步扩展覆盖范围。

- [Markdown](./2085381643687047434/article.md)
- [离线 HTML](./2085381643687047434/article.html)
- [来源 JSON](./2085381643687047434/source.json)
- [X 原文](https://x.com/annabellschfr/status/2085381643687047434)
- 本地媒体：6 个

### Good evals are boring

如何选择确定性评估器或 LLM-as-a-judge，并用标注样本校准评估器。

- [Markdown](./2085161454668513642/article.md)
- [离线 HTML](./2085161454668513642/article.html)
- [来源 JSON](./2085161454668513642/source.json)
- [X 原文](https://x.com/lotte_verheyden/status/2085161454668513642)
- 本地媒体：2 个

### Yes, you can copy our eval setup

Langfuse 文档聊天机器人的可复用评测方案：追踪、监控、数据集与实验闭环。

- [Markdown](./2079939078087188874/article.md)
- [离线 HTML](./2079939078087188874/article.html)
- [来源 JSON](./2079939078087188874/source.json)
- [X 原文](https://x.com/annabellschfr/status/2079939078087188874)
- 本地媒体：11 个

### Tracing agent memory operations in Langfuse with EverOS

通过原生 OpenTelemetry 将 Agent Memory 的写入、召回、合并、置信度与成本送入 Langfuse。

- [Markdown](./2085292697074438505/article.md)
- [离线 HTML](./2085292697074438505/article.html)
- [来源 JSON](./2085292697074438505/source.json)
- [X 原文](https://x.com/langfuse/status/2085292697074438505)
- 本地媒体：3 个

### Manage Langfuse dashboards via API, CLI, and MCP

用 API、CLI、MCP 和 Langfuse Assistant 以代码或 Agent 管理 dashboard、placement 与 widget。

- [Markdown](./2079863575007420562/article.md)
- [离线 HTML](./2079863575007420562/article.html)
- [来源 JSON](./2079863575007420562/source.json)
- [X 原文](https://x.com/langfuse/status/2079863575007420562)
- 本地媒体：2 个

### OpenTelemetry-native tracing with Langfuse

Langfuse 的 OTLP 入口、认证、v4 实时摄取 header、属性传播与多语言接入方式。

- [Markdown](./2080280718836367816/article.md)
- [离线 HTML](./2080280718836367816/article.html)
- [来源 JSON](./2080280718836367816/source.json)
- [X 原文](https://x.com/langfuse/status/2080280718836367816)
- 本地媒体：1 个

## 来源与限制

- 当前环境没有安装 `opencli`，因此无法使用已登录浏览器配置直接调用 X 搜索命令。
- 检索阶段使用公开搜索结果与 `@langfuse` 公开动态发现候选；正文通过 X 的公开嵌入/文章数据接口核对，并保留原始响应。
- 三篇 X Article 保存了完整正文；三条普通帖子保存真实帖文，并附其明确链接的 Langfuse 官方文档快照。
- X 视频未单独下载；成功发现的静态图片已保存到对应 `images/`。
