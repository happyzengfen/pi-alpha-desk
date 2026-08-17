---
name: mermaid-skill
description: Generate Mermaid diagrams (.mmd) and render to SVG/PNG locally (bundled app: render via frontend mermaid; office-pptx for charts). USE THIS SKILL when user mentions diagram, flowchart, sequence diagram, class diagram, ER diagram, state machine, architecture, visualize, git graph, 画图, 架构图, 流程图, 时序图. PROACTIVELY USE when explaining ANY system with 3+ components, API flows, authentication sequences, class hierarchies, database schemas, or state machines. Supports 12+ diagram types with fully automatic layout.
homepage: https://github.com/Agents365-ai/creating-mermaid-diagrams
metadata: {"emoji":"📊"}
---

# Mermaid Diagrams

Generate `.mmd` text files and render to SVG/PNG locally（应用内离线方案，不依赖 mmdc/Kroki）。

**Key advantage:** Text-based syntax with **fully automatic layout** — no x/y coordinates needed.

## When to use / when NOT to use

**Use this skill for:** diagrams-as-code with automatic layout (flowchart, sequence, class, state, ER, gantt, mindmap, architecture) — text source that lives in git and embeds in Markdown.

**Do NOT use it — route elsewhere — for:**
- Pixel-precise placement, custom layout, branded icons, or heavy styling → **drawio**.
- A hand-drawn / sketchy aesthetic → **excalidraw** or **tldraw**.
- A freeform whiteboard or freehand strokes → **tldraw**.
- Strict, conventional UML notation → **plantuml**.

## Prerequisites

**本环境（数字化AI助手打包版，离线）渲染方案**：不依赖 mmdc/Puppeteer/Kroki。

- 核心产出：`.mmd` 源文件（文本，随文档/仓库保留）
- 渲染出口（按可用性选择）：
  1. **前端渲染（推荐）**：应用内置 mermaid 依赖（package.json 已有），在前端/浏览器环境调用 `mermaid.render` 把 `.mmd` 渲染为 SVG/PNG；`mermaid.parse` 可先做语法验证
  2. **office-pptx**：数据图表类展示改用 office-pptx skill 生成原生图表
  3. 可选：用户机器若装有 mmdc/Kroki，也可用于导出（非必需）

## Workflow

1. **Check deps** — 确认环境：离线模式（打包版）下直接走前端 mermaid 渲染；无需 mmdc/Chrome
2. **Pick diagram type** — choose from table below
3. **Generate** — write `.mmd` file to disk
4. **Validate** — run validation (REQUIRED before export)
5. **Export** — 用本地方案渲染：前端 mermaid（推荐）或 mmdc/Kroki（如有）；至少产出 SVG，PNG 视环境
6. **Self-check (vision)** — read the exported PNG and fix readability/layout defects that automatic layout can't prevent (clipped labels, cramped density, wrong orientation), then re-validate + re-export. Max 2 rounds; skip if no vision. See **Self-Check (vision)** below.
7. **Review loop** — show the image to the user, apply the minimal `.mmd` edit per request, re-export until approved (5-round safety valve). See **Review Loop** below.
8. **Report** — tell user the output file paths

## Validation (Required)

**NEVER 在渲染前跳过语法验证。**

```bash
# 前端验证（打包版推荐）：mermaid.parse(mmdText) 抛错即语法错误
# 浏览器控制台：mermaid.parse('flowchart TD; A-->B')
```

# 若用 mmdc（用户机器自装，可选）：
# mmdc -i diagram.mmd -o /tmp/test.png 2>&1

# 若语法错误，修正 .mmd 后重新验证；验证通过后才渲染

Common validation errors:
- Missing quotes around labels with special characters
- Wrong arrow syntax (use `->>` for sequence, `-->` for flowchart)
- Undeclared participants in sequence diagrams

> 打包版离线环境无 mmdc/Chrome：语法验证用前端 `mermaid.parse`，渲染用前端 `mermaid.render`（SVG）或 office-pptx（图表）。

## Self-Check (vision)

Validation (above) only proves the syntax is legal — it says nothing about whether the **rendered** diagram is readable. After exporting, use the agent's vision capability to read the PNG and catch what automatic layout can't prevent. Mermaid positions everything itself, so the failures here are about content and readability, **not** overlaps:

| Check | What to look for | Fix |
|---|---|---|
| Label truncation | Node / edge text clipped or cut off | Shorten the label, or wrap it with `<br/>` |
| Cramped, unreadable density | Too many nodes crammed together; tangled lines | Flip direction (`TD`↔`LR`), split into `subgraph`s, or reduce nodes |
| Wrong orientation / aspect | Diagram far too wide or too tall to read | Change `flowchart TD`↔`LR` (or set `direction` in class/state) |
| Edge spaghetti | Many edges crossing, hard to follow | Reorder node declarations so connected nodes sit adjacent; group with `subgraph` |
| Wrong diagram type | Type doesn't suit the content (e.g. flowchart for a timeline) | Switch type (`gantt`, `sequenceDiagram`, `stateDiagram-v2`, …) |
| Low contrast | Text blends into the node fill | Adjust `classDef` / theme so text contrasts the fill |

- Max **2 self-check rounds** — if issues remain after 2 fixes, show the user anyway.
- **Re-validate (syntax) and re-export after every fix.**
- If vision is unavailable, skip self-check and show the PNG directly.

## Review Loop

After self-check, show the exported image and collect feedback. Apply the **minimal `.mmd` edit** for each request, then re-validate and re-export:

| User request | Edit action |
|---|---|
| Change a label | Edit the node / edge text in the `.mmd` |
| Add / remove a node or edge | Add or delete the matching line |
| Change a color | Add / adjust a `classDef` and `class <node> <className>` |
| Change layout direction | Swap `TD`↔`LR` (flowchart) or set `direction` (class / state) |
| Restructure / group | Wrap related nodes in a `subgraph`, or regenerate |

- Overwrite the same `diagram.mmd` / `diagram.png` each round — don't create `v1`, `v2`, …
- **Safety valve:** after 5 rounds, suggest the user fine-tune at [mermaid.live](https://mermaid.live).

## Diagram Types

| Type | Keyword | Use for |
|------|---------|---------|
| Flowchart | `flowchart TD/LR` | processes, pipelines, decisions |
| Sequence | `sequenceDiagram` | API calls, message passing |
| Class | `classDiagram` | OOP models, data structures |
| ER | `erDiagram` | database schemas |
| State | `stateDiagram-v2` | state machines, lifecycle |
| Gantt | `gantt` | project timelines |
| Pie | `pie` | proportions |
| Git Graph | `gitGraph` | branch strategies |
| C4 Context | `C4Context` | high-level system context |
| Architecture | `architecture-beta` | cloud / CI/CD service layouts |
| Mind Map | `mindmap` | topic breakdowns |
| User Journey | `journey` | user-experience flows |

## Syntax Reference

**Flowchart**: See [reference/FLOWCHART.md](reference/FLOWCHART.md)
**Sequence**: See [reference/SEQUENCE.md](reference/SEQUENCE.md)
**Class & ER**: See [reference/CLASS-ER.md](reference/CLASS-ER.md)
**Architecture**: See [reference/ARCHITECTURE.md](reference/ARCHITECTURE.md)
**Other types**: See [reference/OTHER-TYPES.md](reference/OTHER-TYPES.md)

## Examples

### Example 1: API Authentication Flow

**User prompt:**
> Create a sequence diagram for JWT authentication

**Generated `.mmd`:**
```mermaid
sequenceDiagram
  participant C as Client
  participant G as API Gateway
  participant A as Auth Service
  participant D as Database

  C->>G: POST /login {email, password}
  G->>A: validate(credentials)
  A->>D: SELECT user WHERE email=?
  D-->>A: user record
  A-->>A: verify password hash
  A-->>G: 200 OK + JWT token
  G-->>C: {token: "eyJhbG..."}
```

**Output files:** `auth-flow.mmd` + `auth-flow.png`

---

### Example 2: Microservices Architecture

**User prompt:**
> Draw an e-commerce microservices architecture

**Generated `.mmd`:**
```mermaid
flowchart TD
  subgraph Clients
    M[Mobile App]
    W[Web App]
  end

  GW[API Gateway]

  subgraph Services
    US[User Service]
    OS[Order Service]
    PS[Product Service]
    PAY[Payment Service]
  end

  subgraph Data
    UDB[(User DB)]
    ODB[(Order DB)]
    PDB[(Product DB)]
    REDIS[(Redis Cache)]
  end

  M & W --> GW
  GW --> US & OS & PS & PAY
  US --> UDB
  OS --> ODB
  PS --> PDB
  PAY --> REDIS
```

**Output files:** `ecommerce-arch.mmd` + `ecommerce-arch.png`

---

### Example 3: Order State Machine

**User prompt:**
> Show order lifecycle states

**Generated `.mmd`:**
```mermaid
stateDiagram-v2
  [*] --> Pending : order created
  Pending --> Confirmed : payment success
  Pending --> Cancelled : timeout/cancel
  Confirmed --> Shipped : dispatched
  Shipped --> Delivered : received
  Delivered --> [*]
  Cancelled --> [*]
```

**Output files:** `order-states.mmd` + `order-states.png`

---

### Example 4: Cloud Architecture

**User prompt:**
> Draw a simple service architecture for an API

**Generated `.mmd`:**
```mermaid
architecture-beta
  group api(cloud)[API]

  service gateway(internet)[Gateway] in api
  service db(database)[Database] in api
  service cache(disk)[Cache] in api

  gateway:R --> L:db
  gateway:B --> T:cache
```

**Output files:** `api-architecture.mmd` + `api-architecture.png`

## Export Commands

### Option 1: Local Export (mmdc)

Requires `mmdc` installed locally. Best for offline use.

```bash
# PNG (recommended: 2048px wide, white background)
mmdc -i diagram.mmd -o diagram.png -w 2048 --backgroundColor white

# PNG with theme — valid -t values: default | dark | neutral | forest
# (`base` is NOT a valid -t value; it only works inside a %%{init: {'theme':'base'}}%% directive)
mmdc -i diagram.mmd -o diagram.png -w 2048 --backgroundColor white --theme neutral

# SVG
mmdc -i diagram.mmd -o diagram.svg

# PDF
mmdc -i diagram.mmd -o diagram.pdf
```

### Option 2: Kroki API (No Install Required)

Use [Kroki](https://kroki.io) when `mmdc` is not available. No local dependencies needed.

```bash
# SVG via Kroki
curl -X POST -H "Content-Type: text/plain" --data-binary @diagram.mmd https://kroki.io/mermaid/svg -o diagram.svg

# PNG via Kroki
curl -X POST -H "Content-Type: text/plain" --data-binary @diagram.mmd https://kroki.io/mermaid/png -o diagram.png

# PDF is NOT supported by Kroki for Mermaid — POSTing to /mermaid/pdf returns
# HTTP 400 ("Unsupported output format: pdf for mermaid. Must be one of png or svg").
# For PDF, use the local mmdc path instead:  mmdc -i diagram.mmd -o diagram.pdf
```

**Kroki advantages:**
- No local installation required
- Works on any system with `curl`
- Supports 20+ diagram types (PlantUML, GraphViz, D2, etc.)

**When to use Kroki:**
- `mmdc` installation fails
- Quick one-off diagrams
- CI/CD pipelines without Node.js

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| `mmdc` not found | `npm install -g @mermaid-js/mermaid-cli` |
| `mmdc` error `Could not find Chrome` | Install the headless browser: `npx puppeteer browsers install chrome-headless-shell` (or use Kroki) |
| Kroki PDF fails with HTTP 400 | Kroki does PNG/SVG only for Mermaid; use local `mmdc` for PDF |
| Valid diagram reported "invalid" by `mmdc` | The error is a Chrome/puppeteer setup failure, not a syntax error — don't rewrite correct `.mmd`; fix the browser or validate via Kroki |
| Wrong arrow in sequence | Use `->>` for request, `-->>` for response |
| Special chars in label | Wrap in quotes: `A["Label: value"]` |
| Blank/small output | Add `-w 2048` flag |
| Participant order wrong | Declare `participant` explicitly at top |
| Subgraph name with spaces | Wrap in quotes: `subgraph "My Layer"` |
