# Agent Autoloop source receipt

- Repository: https://github.com/KKKKhazix/agent-autoloop
- Commit: `8f8e2eef3cfaa8f7a418818adc442450fe6bd884`
- License: MIT; original notice is retained in [LICENSE](LICENSE).
- Imported scope: `kernel/`, the directly used protocol client/types/validators, and `worker/contract.ts`.
- Excluded: upstream host runtime, shell worker, installers, CLI, system services, and plugins.
- Imported text files normalize redundant final blank lines; behavior changes are listed below.
- Local source changes: `protocol/rules.ts` accepts absolute Windows drive and UNC cwd syntax in addition to POSIX/home paths. This is syntax validation only; the Pi worker must still canonicalize and authorize the actual directory. Record any later source patches here.
- `kernel/credentials.ts` adds an optional typed result transformation hook. `kernel/decide.ts` invokes it after authenticating a run and hashing the original submitted body, so task cancellation can suppress scheduling effects without breaking identical-receipt retries.
- `kernel/decide.ts` adds a trusted `desktopTrigger` command for the owner-only host endpoint. It reuses event deduplication and enqueue logic and can explicitly trigger an enabled cron rule without editing its filter.
- `kernel/http.ts` threads optional `expectedVersion` on card answer/resolve to the local transaction wrapper. A stale version returns 409; omitting it preserves upstream compatibility.

The application host in `../host/` is local code. It initializes the upstream core explicitly with an application-owned directory and uses a stable projection format version rather than reading TypeScript source files at runtime.
