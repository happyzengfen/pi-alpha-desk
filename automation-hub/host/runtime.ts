import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { credential, digest, whose, type Environment } from "../upstream/kernel/credentials.ts";
import { NotFound } from "../upstream/kernel/errors.ts";
import { rows, statement, type Fact, type Row, type Table } from "../upstream/kernel/evolve.ts";
import * as query from "../upstream/kernel/query.ts";
import { SCHEDULE } from "../upstream/kernel/rules.ts";
import { stateOf } from "../upstream/kernel/state.ts";
import { commitLatest, openView } from "../upstream/kernel/store.ts";
import { parseRules } from "../upstream/protocol/rules.ts";
import { desktopClaimEligible, desktopDecision, desktopStatus } from "./desktop-decisions.ts";

export const UPSTREAM_COMMIT = "8f8e2eef3cfaa8f7a418818adc442450fe6bd884";
// Bump when a local projection/schema change needs a log rebuild. This survives compilation.
const PROJECTION_FORMAT = `pi-alpha-desk-automation-v2:${UPSTREAM_COMMIT}`;
const WORKER = "pi-desktop";
const SOURCE = "desktop";

export function atomicPrivateFile(file: string, content: string) {
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600, flag: "wx", flush: true });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

export function defaultRules(timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  return {
    timezone,
    sources: { [SOURCE]: { name: "Desktop" } },
    agents: { pi: { name: "Pi", use: "pi", worker: WORKER, access: "read" } },
    channels: {},
    rules: [],
  };
}

export function createRuntime({ dataDir, now = Date.now }: { dataDir: string; now?: () => number }) {
  if (!isAbsolute(dataDir)) throw new Error("Automation data directory must be absolute");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const masterFile = join(dataDir, "master.key");
  if (!existsSync(masterFile)) writeFileSync(masterFile, randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx", flush: true });
  const secret = readFileSync(masterFile, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error("Automation master.key is invalid; restore the original key from backup");
  chmodSync(masterFile, 0o600);
  const environment: Environment = { secret, publicUrl: "", canClaim: desktopClaimEligible };
  const dbFile = join(dataDir, "hub.db");
  const db = new DatabaseSync(dbFile);
  try {
    chmodSync(dbFile, 0o600);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    db.function("card_token", { deterministic: true }, (id, at) => credential(environment, "card", id, at));
    db.function("card_hash", { deterministic: true }, (id, at) => digest(credential(environment, "card", id, at)));
    db.exec("CREATE TABLE IF NOT EXISTS facts(seq INTEGER PRIMARY KEY, fact TEXT NOT NULL); CREATE TABLE IF NOT EXISTS projections(collection TEXT,key TEXT,data TEXT NOT NULL,PRIMARY KEY(collection,key));");
    const schema = readFileSync(new URL("../upstream/kernel/schema.sql", import.meta.url), "utf8");
    const views: string[] = [];
    for (const [, table, body] of schema.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
      const columns = [...body.matchAll(/^  (\w+) (?:INTEGER|TEXT)/gm)].map(([, column]) => column);
      const selected = columns.map((column) => column === "token"
        ? "card_token(json_extract(data,'$.id'),json_extract(data,'$.created_at')) AS token"
        : `json_extract(data,'$.${column}') AS ${column}`);
      views.push(`DROP VIEW IF EXISTS ${table}; CREATE VIEW ${table} AS SELECT ${selected.join(",")} FROM projections WHERE collection='${table}'`);
    }
    db.exec(`BEGIN IMMEDIATE; ${views.join(";")}; COMMIT`);
    const format = `${PROJECTION_FORMAT}:${digest(secret)}`;
    let current = openView(db, format);
    db.exec("CREATE INDEX IF NOT EXISTS projection_card_hash ON projections(card_hash(json_extract(data,'$.id'),json_extract(data,'$.created_at'))) WHERE collection='cards'");
    const listeners = new Set<(type: string, facts: Fact[]) => void>();
    const all = <T>(sql: string, params: SQLInputValue[] = []) => db.prepare(sql).all(...params).map((row) => ({ ...row }) as T);
    const getView = () => (current = openView(db, format));
    const onChange = (listener: (type: string, facts: Fact[]) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    };
    // Keep new task-generation/resource-owner checks inside this transaction, not in HTTP or worker memory.
    function execute(type: string, args: unknown[], at = now()) {
      let facts: Fact[] = [];
      let value: unknown;
      current = commitLatest(db, format, (latest) => {
        ({ facts, value } = desktopDecision(latest, type, args, at, environment));
        return facts;
      });
      if (facts.length) for (const listener of listeners) listener(type, facts);
      return value;
    }
    const rulesFile = join(dataDir, "rules.json");
    const readRules = () => {
      const rules = structuredClone(query.configuration(getView()));
      delete rules.sources[SCHEDULE];
      return rules;
    };
    function setRules(given: unknown, persist = true) {
      const text = JSON.stringify(given);
      const rules = parseRules(text, now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
      // The file is durable before activation; startup can finish activation after a crash between the two.
      if (persist) atomicPrivateFile(rulesFile, `${JSON.stringify(given, null, 2)}\n`);
      if (JSON.stringify(rules) !== JSON.stringify(query.configuration(getView()))) execute("rules", [rules]);
      return readRules();
    }
    const savedRules = existsSync(rulesFile) ? readFileSync(rulesFile, "utf8") : null;
    if (savedRules !== null && !current.get("config", "desktop")) {
      try { setRules(JSON.parse(savedRules), false); }
      catch (error) {
        if (!current.get("config", "rules")) throw error;
        execute("rulesError", [error instanceof Error ? error.message : "Invalid rules file"]);
      }
    } else if (!current.get("config", "rules")) setRules(defaultRules());
    const addKey = (kind: string, name: string) => {
      const key = randomBytes(32).toString("base64url");
      execute("key", [kind, name, digest(key)]);
      return key;
    };
    const keys = { ownerKey: addKey("owner", "desktop"), workerKey: addKey("worker", WORKER), sourceKey: addKey("source", SOURCE) };
    const logAfter = (after = 0, limit = -1) => all<{ fact: string }>("SELECT fact FROM facts WHERE seq > ? ORDER BY seq LIMIT ?", [after, limit]).map(({ fact }) => query.safeFact(JSON.parse(fact)));
    const cardByToken = (token: string) => {
      const row = statement(db, "SELECT data FROM projections WHERE collection='cards' AND card_hash(json_extract(data,'$.id'),json_extract(data,'$.created_at'))=?").get(digest(token));
      return row ? JSON.parse(String(row.data)) as Row : undefined;
    };
    function why(id: number) {
      const latest = getView();
      if (!latest.get("runs", id)) throw new NotFound("没有这一轮");
      const events = query.eventsOf(latest, id).map((event) => event.id);
      const cards = [...rows(latest, "cards", { run_id: id }), ...rows(latest, "cards", { answer_event: events })];
      const sequences = new Set<number>();
      const include = (table: Table, key: string | number) => {
        for (const row of statement(db, "SELECT seq FROM projection_refs WHERE collection=? AND key=?").all(table, String(key))) sequences.add(Number(row.seq));
      };
      const read = (seq: number) => JSON.parse(String(statement(db, "SELECT fact FROM facts WHERE seq=?").get(seq)!.fact)) as Fact;
      include("runs", id);
      for (const seq of [...sequences]) for (const change of read(seq).changes)
        if (change.table === "runs" && change.key === String(id) && change.row?.rules_version) sequences.add(change.row.rules_version);
      for (const event of events) include("events", event);
      for (const card of cards) include("cards", card.id);
      return [...sequences].sort((a, b) => a - b).map((seq) => query.safeFact(read(seq)));
    }
    return {
      db, environment, keys, now, execute, getView, onChange, readRules, setRules, logAfter, cardByToken, why,
      desktopStatus: (run?: number) => ({ ...desktopStatus(getView(), now()),
        ...(run !== undefined && { reconciled: getView().get("runs", run)?.desktop_reconciled === true }) }),
      setDesktopConfig: (config: unknown, compiled: unknown) => execute("desktopConfig", [config, parseRules(JSON.stringify(compiled), now(), Intl.DateTimeFormat().resolvedOptions().timeZone)]),
      workerName: WORKER, sourceName: SOURCE,
      whose: (kind: string, key: string) => whose(getView(), kind, key),
      state: (at: number, before?: number) => stateOf(at, before, query.configuration(getView()), {
        all,
        view: (card: Row) => query.cardView(card, environment),
        unrouted: () => query.unrouted(getView()),
      }),
      nextDeadline: () => all<{ at: number | null }>("SELECT MIN(json_extract(data, '$.at')) AS at FROM projections WHERE collection='due'")[0]?.at,
      close: () => { listeners.clear(); db.close(); },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

export type Runtime = ReturnType<typeof createRuntime>;
