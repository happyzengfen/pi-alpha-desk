# Security Review: @iswitthere/pi-web-desktop

## Scope

Single-pass review of the Electron boundary, HTTP trust controls, filesystem authorization, uploads, credentials, executable entry points, project resources, sessions, themes, and production dependency exposure.

- Scan mode: scoped_path
- Target kind: git_worktree
- Target ID: pi-web-desktop-81b71ffee143-security-remediation
- Revision: 81b71ffee143b617b77fd9dcaa2ab04980cc1145
- Snapshot digest: codex-security-snapshot/v1:sha256:58ca27432b85fa92f425fc6dfe26de10a60a3dc029a168cb768dc2e2e9c2dc6b
- Inventory strategy: scoped_path
- Included paths: proxy.ts, next.config.ts, electron/, app/api/agent/, app/api/auth/, app/api/cwd/, app/api/default-cwd/, app/api/file-index/, app/api/files/, app/api/git/, app/api/models-config/, app/api/plugins/, app/api/project-trust/, app/api/sessions/, app/api/skills/, app/api/themes/, app/api/worktrees/, lib/allowed-roots.ts, lib/atomic-file.ts, lib/bounded-form-data.ts, lib/file-access.ts, lib/file-upload.ts, lib/git-changes.ts, lib/npx.ts, lib/project-trust.ts, lib/provider-credential-store.ts, lib/request-security.ts, lib/rpc-manager.ts, lib/session-file-references.ts, lib/session-file-references-core.ts, lib/skill-updates.ts, lib/theme-access.ts, lib/theme.ts, lib/worktree.ts
- Excluded paths: ref-repos/, release/, node_modules/
- Runtime or test status: Parent-led fallback; independent scan workers were unavailable by runtime policy.

Limitations and exclusions:
- Pure presentation components and generated release artifacts were outside this security-focused scope.
- Windows runtime behavior is covered by source and packaging tests but was not executed on a Windows host in this scan.
- Excluded components/ and app/globals.css presentation-only code: No privileged operation was identified there beyond the separately reviewed rendering and IPC call chains.
- Excluded release/ and ref-repos/: Generated packaging output and read-only upstream comparison material are not authoritative product source.

### Scan Summary

| Field | Value |
| --- | --- |
| Reportable findings | 0 |
| Severity mix | none |
| Confidence mix | none |
| Coverage | complete |
| Validation mode | Static source review plus targeted negative tests, full project tests, TypeScript, ESLint, dependency audit, and diff validation. |

Canonical artifacts: `scan-manifest.json`, `findings.json`, and `coverage.json`. This report is a deterministic projection of those files.

## Threat Model

A loopback-first Electron application exposes a Next.js API with broad local filesystem, process, credential, session, plugin, and model capabilities; untrusted inputs include renderer content, chat/model output, project files, browser requests, uploaded files, package identifiers, and OAuth callbacks.

### Assets

- Files under authorized workspace and session roots
- Provider API keys and OAuth credentials
- Agent sessions and model configuration
- Desktop process privileges and operating-system shell actions

### Trust Boundaries

- Renderer to Electron main process IPC
- Browser or renderer to loopback Next.js API
- Requested paths to canonical filesystem objects
- Repository-controlled resources to the Pi runtime
- Package and command inputs to child processes

### Attacker Capabilities

- Supply chat, Markdown, Mermaid, file, path, upload, theme, and package inputs
- Control files and symbolic links inside an authorized project
- Attempt cross-origin loopback requests or renderer navigation
- Influence repository-local Pi resources before project trust is granted

### Security Objectives

- Keep API access loopback-scoped and origin-validated
- Prevent filesystem access outside canonical authorized roots
- Prevent untrusted renderer content from invoking privileged IPC or arbitrary protocols
- Keep credentials private and updates crash-safe
- Avoid shell interpretation of package and Git arguments

### Assumptions

- The local operating-system account is trusted to access its own Pi data
- LAN exposure remains disabled unless separately security-reviewed
- Project resources execute only after the existing project-trust gate

## Findings

### No findings

No reportable findings survived the canonical discovery, validation, and reportability gates.

## Reviewed Surfaces

| Surface | Risk Area | Outcome | Notes |
| --- | --- | --- | --- |
| Loopback HTTP Host, Origin, password, and response-header boundary | network-boundary | No issue found | Central proxy enforcement and security response headers were reviewed and regression-tested. |
| Electron renderer sandbox, navigation, popup, webview, and IPC boundary | desktop-privilege-boundary | No issue found | The renderer is sandboxed; privileged IPC requires the main frame and exact application origin; external protocols are restricted to HTTP(S). |
| Filesystem reads, writes, uploads, indexing, Git views, themes, and session references | path-authorization | No issue found | Canonical realpath authorization now rejects existing and future paths traversing a symlink outside allowed roots. |
| Provider credentials, OAuth callback tokens, and model configuration | secret-management | No issue found | Credential updates use locked atomic private-file replacement and OAuth callback tokens use cryptographic randomness. |
| Plugin, skill, Git, export, and package child-process execution | command-execution | No issue found | Reviewed process launches use argument-vector APIs without shell interpolation; repository resources retain project-trust gating. |
| Markdown, Mermaid, file preview, and theme content handling | content-injection | No issue found | Mermaid strict mode and upgraded patched rendering dependencies were verified; theme HTTP access now rejects path-shaped names and unauthorized cwd values. |
| Production dependency vulnerability exposure | supply-chain | No issue found | Next, Mermaid, Undici and vulnerable transitive packages were upgraded; npm audit --omit=dev reports zero vulnerabilities. |
