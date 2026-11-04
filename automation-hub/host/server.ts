import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { createHandler } from "../upstream/kernel/http.ts";
import { AuthError, Conflict, InputError, NotFound } from "../upstream/kernel/errors.ts";
import { RulesError } from "../upstream/protocol/rules.ts";
import { createRuntime, UPSTREAM_COMMIT, type Runtime } from "./runtime.ts";

const LONGEST_TIMER = 2147483647;
const MAX_RULE_BYTES = 1024 * 1024;

function logStream(runtime: Runtime, after: number, signal: AbortSignal, key: string) {
  let cursor = after;
  let unsubscribe = () => {};
  let stop = () => {};
  let stopped = false;
  const detach = () => { unsubscribe(); signal.removeEventListener("abort", stop); };
  let send = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stop = () => { if (stopped) return; stopped = true; detach(); controller.close(); };
      send = () => {
        if (stopped) return;
        if (!runtime.whose("owner", key)) return stop();
        if ((controller.desiredSize ?? 0) <= 0) return;
        for (const fact of runtime.logAfter(cursor, 1)) {
          cursor = fact.seq;
          controller.enqueue(new TextEncoder().encode(`id: ${fact.seq}\nevent: fact\ndata: ${JSON.stringify(fact)}\n\n`));
        }
      };
      unsubscribe = runtime.onChange(send);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
    },
    pull() { send(); },
    cancel() { stopped = true; detach(); },
  });
}

function createRouter(runtime: Runtime, instanceId: string) {
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const waiting = new Set<{ until: number; done: () => void }>();
  const wake = () => { for (const waiter of [...waiting]) waiter.done(); };
  const arm = () => {
    clearTimeout(timer);
    if (closed) return;
    const next = Math.min(runtime.nextDeadline() ?? Infinity, ...[...waiting].map((waiter) => waiter.until));
    if (!Number.isFinite(next)) return;
    timer = setTimeout(() => {
      runtime.execute("tick", []);
      wake();
      arm();
    }, Math.max(0, Math.min(LONGEST_TIMER, next - runtime.now())));
  };
  const unlisten = runtime.onChange((type, facts) => {
    const justSeen = type === "heartbeat" || type === "channelSeen";
    if (!justSeen || facts.some((fact) => fact.changes.some((change) => change.table === "cards"))) wake();
    arm();
  });
  const core = createHandler({
    commit: UPSTREAM_COMMIT,
    now: runtime.now,
    view: runtime.getView,
    environment: runtime.environment,
    dispatch: runtime.execute,
    state: runtime.state,
    why: runtime.why,
    card: runtime.cardByToken,
    wait(until, signal) {
      return new Promise<void>((resolve) => {
        const waiter = { until, done() { waiting.delete(waiter); signal.removeEventListener("abort", waiter.done); resolve(); } };
        waiting.add(waiter);
        signal.addEventListener("abort", waiter.done, { once: true });
        if (signal.aborted || closed) waiter.done();
        arm();
      });
    },
    stream: (after, signal, key) => logStream(runtime, after, signal, key),
    adapt: async () => { throw new NotFound("External webhook adapters are not enabled"); },
  });
  runtime.execute("tick", []);
  arm();
  return {
    async handle(request: Request) {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/healthz") return Response.json({ ok: true, commit: UPSTREAM_COMMIT, instanceId });
      if ((path === "/v1/rules" || path.startsWith("/v1/desktop/")) && ["GET", "PUT", "POST"].includes(request.method)) {
        const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        if (!runtime.whose("owner", token)) return Response.json({ error: "Owner authentication required" }, { status: 401 });
        if (request.method === "GET") {
          const data = path === "/v1/rules" ? { rules: runtime.readRules() }
            : path === "/v1/desktop/config" ? { config: runtime.desktopStatus().config }
            : path === "/v1/desktop/status" ? runtime.desktopStatus(new URL(request.url).searchParams.has("run") ? Number(new URL(request.url).searchParams.get("run")) : undefined) : null;
          return Response.json(data ?? { error: "No endpoint" }, { status: data ? 200 : 404, headers: { "cache-control": "no-store" } });
        }
        try {
          if (Number(request.headers.get("content-length")) > MAX_RULE_BYTES) return Response.json({ error: "Rules are too large" }, { status: 413 });
          let bytes = 0;
          const chunks: Uint8Array[] = [];
          const reader = request.body?.getReader();
          while (reader) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_RULE_BYTES) return Response.json({ error: "Rules are too large" }, { status: 413 });
            chunks.push(value);
          }
          const given = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!given || typeof given !== "object" || Array.isArray(given)) throw new InputError("Expected a JSON object");
          let data: unknown;
          if (path === "/v1/desktop/config" && request.method === "PUT") data = runtime.setDesktopConfig(given.config, given.rules);
          else if (path === "/v1/desktop/trigger" && request.method === "POST") {
            if (typeof given.ruleId !== "string" || (given.eventId !== undefined && typeof given.eventId !== "string")) throw new InputError("ruleId and eventId must be strings");
            data = runtime.execute("desktopTrigger", [given.ruleId, { id: given.eventId ?? randomUUID(), type: `desktop.run.${given.ruleId}`, subject: given.ruleId }]);
          } else if (path === "/v1/desktop/disable" && request.method === "POST") data = runtime.execute("desktopDisable", [given.ruleId]);
          else if (path === "/v1/desktop/cancel" && request.method === "POST") data = runtime.execute("desktopCancel", [given.ruleId]);
          else if (path === "/v1/desktop/reconcile" && request.method === "POST") data = runtime.execute("desktopReconcile", [given.run, given.confirmedStopped, given.completed]);
          else if (path === "/v1/rules" && request.method === "PUT") {
            if (runtime.desktopStatus().config) throw new Conflict("Desktop configuration owns these rules");
            data = { rules: runtime.setRules(given) };
          } else return Response.json({ error: "No endpoint" }, { status: 404 });
          return Response.json(data, { headers: { "cache-control": "no-store" } });
        } catch (error) {
          if (error instanceof SyntaxError || error instanceof RulesError || error instanceof InputError) return Response.json({ error: error.message }, { status: 400 });
          if (error instanceof AuthError) return Response.json({ error: error.message }, { status: 401 });
          if (error instanceof Conflict || error instanceof NotFound) return Response.json({ error: error.message }, { status: error instanceof Conflict ? 409 : 404 });
          throw error;
        }
      }
      return core(request);
    },
    close() { closed = true; clearTimeout(timer); unlisten(); wake(); },
  };
}

export async function listenHub({ dataDir, instanceId, now }: { dataDir: string; instanceId: string; now?: () => number }) {
  const runtime = createRuntime({ dataDir, now });
  const router = createRouter(runtime, instanceId);
  const requests = new Set<AbortController>();
  let url = "";
  const server = createServer(async (req, res) => {
    const gone = new AbortController();
    requests.add(gone);
    res.on("close", () => { gone.abort(); requests.delete(gone); });
    try {
      if (req.headers.origin || req.headers.host !== new URL(url).host) {
        res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "Invalid local request origin or host" }));
        return;
      }
      const body = !["GET", "HEAD"].includes(req.method ?? "GET") && { body: Readable.toWeb(req) as ReadableStream, duplex: "half" };
      const request = new Request(`${url}${req.url}`, {
        method: req.method,
        headers: req.headers as HeadersInit,
        signal: gone.signal,
        ...body,
      });
      const answer = await router.handle(request);
      if (!req.complete) res.setHeader("connection", "close");
      res.writeHead(answer.status, Object.fromEntries(answer.headers));
      if (!answer.body) return void res.end();
      Readable.fromWeb(answer.body as unknown as Parameters<typeof Readable.fromWeb>[0]).on("error", () => res.destroy()).pipe(res);
    } catch {
      if (res.headersSent) return void res.destroy();
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "Automation hub request failed" }));
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0 }, () => { server.removeListener("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Automation hub did not bind a loopback port");
    url = `http://127.0.0.1:${address.port}`;
  } catch (error) {
    router.close(); runtime.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    url, runtime,
    close() {
      return closing ??= (async () => {
        router.close();
        for (const request of requests) request.abort();
        await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
        runtime.close();
      })();
    },
  };
}
