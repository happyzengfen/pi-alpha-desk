import { isAbsolute } from "path";
import type { AutomationConfig, AutomationRule, AutomationTrigger } from "./types";

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const RULE_ID = /^rule-[a-z0-9-]{1,47}$/;
const EVENT_TYPE = /^[a-z][a-z0-9_.-]{0,63}$/;

export class AutomationInputError extends Error {}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AutomationInputError("Expected an object");
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new AutomationInputError("Unknown configuration field");
}

function text(value: unknown, name: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new AutomationInputError(`Invalid ${name}`);
  }
  return value.trim();
}

function count(value: unknown, name: string, max: number) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) throw new AutomationInputError(`Invalid ${name}`);
  return Number(value);
}

function triggerOf(given: unknown): AutomationTrigger {
  const value = object(given);
  fields(value, ["kind", "cron", "at"]);
  if (value.kind === "manual" && Object.keys(value).length === 1) return { kind: "manual" };
  if (value.kind === "cron" && value.at === undefined) return { kind: "cron", cron: text(value.cron, "cron", 100) };
  if (value.kind === "once" && value.cron === undefined) {
    const at = text(value.at, "time", 50);
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(at) || !Number.isFinite(Date.parse(at))) {
      throw new AutomationInputError("Time must include a timezone");
    }
    const [year, month, day] = at.slice(0, 10).split("-").map(Number);
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) throw new AutomationInputError("Invalid calendar date");
    return { kind: "once", at: new Date(at).toISOString() };
  }
  throw new AutomationInputError("Invalid trigger");
}

export function parseAutomationRule(given: unknown): AutomationRule {
  const value = object(given);
  fields(value, ["id", "name", "cwd", "prompt", "enabled", "trigger", "provider", "modelId", "thinkingLevel", "timeoutMinutes", "maxDailyRuns", "emits"]);
  const id = text(value.id, "rule id", 60);
  if (!RULE_ID.test(id)) throw new AutomationInputError("Invalid rule id");
  const cwd = text(value.cwd, "directory", 4096);
  if (!isAbsolute(cwd)) throw new AutomationInputError("Directory must be absolute");
  if (typeof value.enabled !== "boolean") throw new AutomationInputError("enabled must be a boolean");
  if ((value.provider === undefined) !== (value.modelId === undefined)) throw new AutomationInputError("provider and modelId must be supplied together");
  const model = value.provider === undefined ? {} : {
    provider: text(value.provider, "provider", 200), modelId: text(value.modelId, "model", 300),
  };
  const thinkingLevel = value.thinkingLevel;
  if (thinkingLevel !== undefined && (typeof thinkingLevel !== "string" || !THINKING.has(thinkingLevel))) throw new AutomationInputError("Invalid thinking level");
  const emits = value.emits ?? [];
  if (!Array.isArray(emits) || emits.length > 10 || emits.some((type) => typeof type !== "string" || !EVENT_TYPE.test(type))) throw new AutomationInputError("Invalid emitted event types");
  return {
    id, name: text(value.name, "name", 120), cwd, prompt: text(value.prompt, "prompt", 16_000),
    enabled: value.enabled, trigger: triggerOf(value.trigger), ...model,
    ...(thinkingLevel !== undefined && { thinkingLevel: thinkingLevel as AutomationRule["thinkingLevel"] }),
    timeoutMinutes: count(value.timeoutMinutes ?? 15, "timeout", 120),
    maxDailyRuns: count(value.maxDailyRuns ?? 25, "daily run limit", 1000), emits: [...new Set(emits)],
  };
}

export function emptyAutomationConfig(): AutomationConfig {
  return { version: 1, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, rules: [] };
}

export function parseAutomationConfig(given: unknown): AutomationConfig {
  const value = object(given);
  fields(value, ["version", "timezone", "rules"]);
  if (value.version !== 1 || !Array.isArray(value.rules) || value.rules.length > 100) throw new AutomationInputError("Invalid automation configuration");
  const timezone = text(value.timezone, "timezone", 100);
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); }
  catch { throw new AutomationInputError("Invalid timezone"); }
  const rules = value.rules.map(parseAutomationRule);
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) throw new AutomationInputError("Duplicate rule id");
  return { version: 1, timezone, rules };
}

/** Only trusted local settings can select execution properties; events cannot. */
export function compileAutomationRules(config: AutomationConfig) {
  return {
    timezone: config.timezone,
    sources: { desktop: { name: "Desktop" } },
    agents: Object.fromEntries(config.rules.filter((rule) => rule.enabled).map((rule) => [`pi-${rule.id}`, {
      name: rule.name, use: "pi", worker: "pi-desktop", access: "read",
      ...(rule.provider && rule.modelId && { model: `${rule.provider}/${rule.modelId}` }),
      ...(rule.thinkingLevel && { effort: rule.thinkingLevel }), timeout: rule.timeoutMinutes,
    }])),
    channels: {},
    rules: config.rules.filter((rule) => rule.enabled).map((rule) => ({
      name: rule.id, group: rule.id, to: `pi-${rule.id}`, cwd: rule.cwd, prompt: rule.prompt, tell: "needed",
      when: rule.trigger.kind === "cron" ? { cron: rule.trigger.cron } : { source: "desktop", types: [`desktop.run.${rule.id}`] },
      ...(rule.emits.length && { emits: { source: "desktop", types: rule.emits } }),
    })),
  };
}
