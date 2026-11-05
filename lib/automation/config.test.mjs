import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { parseRules } from "../../automation-hub/upstream/protocol/rules.ts";

const { parseAutomationConfig, parseAutomationRule, compileAutomationRules } = await createJiti(import.meta.url).import("./config.ts");
const rule = (extra = {}) => ({ id: "rule-test", name: "Test", cwd: path.resolve("/tmp/automation-config"), prompt: "Read and report.", enabled: true, trigger: { kind: "manual" }, ...extra });
const config = (rules = [rule()], extra = {}) => ({ version: 1, timezone: "Asia/Shanghai", rules, ...extra });

test("configuration rejects unknown execution and capability fields instead of accepting commands from data", () => {
  for (const key of ["command", "access", "tools", "agent", "ownerKey", "extensions"]) {
    assert.throws(() => parseAutomationRule(rule({ [key]: "untrusted" })), /Unknown configuration field/);
  }
  assert.throws(() => parseAutomationConfig(config([rule()], { ownerKey: "untrusted" })), /Unknown configuration field/);
  for (const value of [null, [], "config", { version: 2, timezone: "UTC", rules: [] }]) {
    assert.throws(() => parseAutomationConfig(value));
  }
});

test("configuration validates identities, model pairs, duplicate ids and bounded run budgets", () => {
  assert.throws(() => parseAutomationConfig(config([rule(), rule({ name: "Duplicate" })])), /Duplicate rule id/);
  for (const id of ["test", "rule-UPPER", "rule-../escape", `rule-${"x".repeat(48)}`]) assert.throws(() => parseAutomationRule(rule({ id })), /rule id/);
  for (const extra of [
    { provider: "provider" }, { modelId: "model" }, { thinkingLevel: "unlimited" }, { enabled: "true" },
    { cwd: "relative" }, { timeoutMinutes: 0 }, { timeoutMinutes: 121 }, { maxDailyRuns: 0 }, { maxDailyRuns: 1.5 }, { maxDailyRuns: 1001 },
  ]) assert.throws(() => parseAutomationRule(rule(extra)));
  const parsed = parseAutomationRule(rule({ name: " Test ", prompt: " Read ", provider: "provider", modelId: "model", thinkingLevel: "off" }));
  assert.equal(parsed.name, "Test");
  assert.equal(parsed.prompt, "Read");
  assert.equal(parsed.timeoutMinutes, 15);
  assert.equal(parsed.maxDailyRuns, 25);
});

test("timezone and one-time appointments reject invalid calendars and require an explicit offset", () => {
  assert.throws(() => parseAutomationConfig(config([], { timezone: "Not/A_Timezone" })), /timezone/);
  for (const at of [
    "2026-11-04T09:00:00", "2026-02-29T09:00:00+08:00", "2026-04-31T09:00:00Z",
    "2026-13-01T09:00:00Z", "2026-11-04T25:00:00Z", "not a date",
  ]) assert.throws(() => parseAutomationRule(rule({ trigger: { kind: "once", at } })), at);
  const leap = parseAutomationRule(rule({ trigger: { kind: "once", at: "2028-02-29T09:00:00+08:00" } }));
  assert.equal(leap.trigger.at, "2028-02-29T01:00:00.000Z");
  assert.throws(() => parseAutomationRule(rule({ trigger: { kind: "manual", cron: "* * * * *" } })));
  assert.throws(() => parseAutomationRule(rule({ trigger: { kind: "cron", cron: "* * * * *", at: "2028-01-01T00:00:00Z" } })));
});

test("emitted event types are bounded, validated and deduplicated", () => {
  for (const emits of [["Upper"], ["has spaces"], ["../escape"], [""], ["x".repeat(65)], "desktop.done", Array.from({ length: 11 }, (_, n) => `desktop.event${n}`)]) {
    assert.throws(() => parseAutomationRule(rule({ emits })), /emitted event/);
  }
  assert.deepEqual(parseAutomationRule(rule({ emits: ["desktop.done", "desktop.done", "desktop.other"] })).emits, ["desktop.done", "desktop.other"]);
});

test("compiled rules include only enabled identities and preserve manual/cron triggers and read-only capability", () => {
  const parsed = parseAutomationConfig(config([
    rule({ provider: "provider", modelId: "model", thinkingLevel: "high", emits: ["desktop.child"] }),
    rule({ id: "rule-cron", trigger: { kind: "cron", cron: "0 9 * * *" } }),
    rule({ id: "rule-disabled", enabled: false }),
  ]));
  const compiled = compileAutomationRules(parsed);
  assert.deepEqual(Object.keys(compiled.agents).sort(), ["pi-rule-cron", "pi-rule-test"]);
  assert.deepEqual(compiled.rules[0].when, { source: "desktop", types: ["desktop.run.rule-test"] });
  assert.deepEqual(compiled.rules[1].when, { cron: "0 9 * * *" });
  assert.deepEqual(compiled.rules[0].emits, { source: "desktop", types: ["desktop.child"] });
  assert.equal(compiled.rules[0].to, "pi-rule-test");
  assert.equal(compiled.rules[0].group, "rule-test");
  assert.deepEqual(compiled.agents["pi-rule-test"], { name: "Test", use: "pi", worker: "pi-desktop", access: "read", model: "provider/model", effort: "high", timeout: 15 });
  assert.deepEqual(compiled.channels, {});
  assert.doesNotThrow(() => parseRules(JSON.stringify(compiled), Date.now(), "UTC"));
  const boundary = compileAutomationRules(parseAutomationConfig(config([rule({ id: `rule-${"x".repeat(47)}` })])));
  assert.doesNotThrow(() => parseRules(JSON.stringify(boundary), Date.now(), "UTC"));
});
