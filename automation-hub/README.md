# Desktop automation hub

This is an application-owned Node 24 sidecar around the pinned Agent Autoloop core. It does not import the upstream host, install services, run shell agents, or use `~/.agent-autoloop`. Source and license receipts are in [upstream/SOURCE.md](upstream/SOURCE.md) and [upstream/LICENSE](upstream/LICENSE).

## Launch contract

```sh
node automation-hub/host/main.ts --data-dir /absolute/private/automation --descriptor /absolute/private/automation/descriptor.json
```

The equivalent environment variables are `PI_AUTOMATION_HOME` and `PI_AUTOMATION_DESCRIPTOR`. `--instance-id` is optional; otherwise a UUID is generated. Production compilation must retain the SQL resource at `upstream/kernel/schema.sql` relative to the host directory.

The hub binds `127.0.0.1` on an available port and atomically writes a mode-0600 descriptor:

```ts
type Descriptor = {
  version: 1;
  instanceId: string;
  url: string;
  ownerKey: string;
  workerKey: string;
  sourceKey: string;
  pid: number;
  workerName: "pi-desktop";
  sourceName: "desktop";
};
```

Credentials are never written to stdout. `GET /healthz` returns `{ok:true,commit,instanceId}` without secrets. The parent must verify the instance ID before use. Requests with an Origin header or an unexpected Host are rejected; there is no browser CORS entry point. Keep the descriptor server-side. A lock prevents two live hosts from owning the same directory. SIGTERM/SIGINT and parent IPC disconnect close the listener, timers and database and remove only this instance's descriptor/lock.

Tests may import `startHub({dataDir,descriptorFile?,instanceId?,now?})`; it returns `{descriptor,runtime,close()}`. Runtime construction is explicit. `runtime.execute/getView/db` expose the single transaction boundary for focused extensions, not a second scheduler.

## HTTP contract

All authenticated requests use `Authorization: Bearer <key>`. Standard upstream worker/source/card/history APIs remain available: `/v1/work`, `/v1/runs/:id/started`, `/result`, `/cancel`, `/why`, `/v1/events`, `/v1/state`, `/v1/cards/:id/answer`, `/resolve`, and `/v1/stream?after=<seq>`.

The following endpoints require the owner key:

| Endpoint | Input / result |
| --- | --- |
| `GET /v1/rules` | `{rules}` in authoring form, with the reserved schedule source removed |
| `PUT /v1/rules` | Raw upstream rules; diagnostic/bootstrap path, rejected after desktop config takes ownership |
| `GET /v1/desktop/config` | `{config:null}` initially, then the exact saved browser DTO |
| `PUT /v1/desktop/config` | `{config,rules}`; atomically save the trusted DTO and parsed compiled rules in one fact transaction |
| `GET /v1/desktop/status` | `{config,owner,dailyCounts}` |
| `POST /v1/desktop/trigger` | `{ruleId,eventId?}`; owner-trigger an enabled rule, including cron, with event deduplication |
| `POST /v1/desktop/cancel` | `{ruleId}`; fence the current generation and suppress its queued runs, cards, pending timers and late receipt effects |
| `POST /v1/desktop/disable` | `{ruleId}`; atomically disable the current saved rule and fence its work, preserving unrelated concurrent configuration edits |
| `POST /v1/desktop/reconcile` | `{run,confirmedStopped:true}`; release an unresolved resource owner only after the caller has verified execution stopped |

The desktop DTO is opaque except for `version:1`, rule `id/enabled/trigger`, timezone and once scheduling. The Next API must validate all browser fields, canonicalize and authorize directories, and compile upstream `rule.name` from the DTO rule ID. The hub does not grant Pi tools or load extensions. Those are the Pi worker's responsibility.

Card answer and resolve bodies may include `expectedVersion`. It is checked in the decision transaction; stale versions return 409. Older clients omitting it retain the original idempotent behavior.

Cancel fences current work; it does not disable future cron/manual triggers. To stop a rule entirely, use the atomic disable endpoint or save `enabled:false` in desktop config. Background budget actions should use disable, rather than a separate config read/modify/write that can overwrite another editor. Reenabling establishes a new generation. Unchanged once appointments are not rearmed by an unrelated config save; an explicit disable/enable or changed appointment can schedule them again.

## Durability and ownership

- `hub.db` uses SQLite WAL and FULL synchronous commits. Facts and projections commit together, before the HTTP response.
- Desktop config, generations, one-off timers, global execution ownership and daily counts are part of the same fact log. Rebuilding a projection preserves them. An old `rules.json` cannot overwrite an active database-owned desktop config on restart.
- A claim atomically acquires the global owner. Replaying the same claimed execution may renew its token; another claim cannot acquire resources while an owner remains, including `unknown` runs.
- Desktop claims include `job.desktopRule`, a snapshot of the exact trusted rule DTO captured with ownership. Replaying the claim returns that same snapshot across config edits and host restart; the worker must use it for model, thinking, timeout and budget policy rather than a pre-claim config read.
- A valid final receipt releases ownership. Stale-generation receipts are hashed in their original form for idempotency, then reduced to cancelled records without new cards/timers/events. Reconciliation invalidates the old execution token.
- A repeated reconciliation acknowledges the exact previously reconciled run without touching a newer owner. This lets the worker finish local checkpoint cleanup after a crash between hub acknowledgement and file removal.
- `dailyCounts` counts successful fresh claims, including each retry attempt and the currently claimed attempt, by configured timezone day. Same-claim replays do not increment it. A worker enforcing a daily limit checks `count > maxDailyRuns` after claiming.
- Once appointments are ordinary persisted core timer rows; there is no second timer queue. Missing cron occurrences use the upstream coalescing policy.
- The worker must still persist its run/session checkpoint and result outbox before execution/submission, verify Pi and tool processes are stopped before releasing resources, and enforce ordinary-chat conflicts against the owner. The hub alone cannot stop an external side effect or prove that it happened once.

Back up the database consistently (SQLite backup or a stopped host), `master.key`, and the worker checkpoint/outbox. Do not copy only a live main db while ignoring its WAL. `PROJECTION_FORMAT` is an explicit local version; bump it when projection interpretation changes and test replay before release.

## Verification

Run with Node 24:

```sh
node --test automation-hub/hub.test.mjs
./node_modules/.bin/tsc --project automation-hub/tsconfig.json
./node_modules/.bin/eslint automation-hub/host/*.ts automation-hub/hub.test.mjs
```

The tests run the real vendored core and HTTP host, including both cancellation/result orders, replay after a forced projection rebuild, and a real SIGKILL/restart. They use temporary data and make no model calls. OS-specific packaging and Pi execution remain separate integration checks.
