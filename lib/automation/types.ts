export type AutomationTrigger =
  | { kind: "manual" }
  | { kind: "cron"; cron: string }
  | { kind: "once"; at: string };

export interface AutomationRule {
  id: string;
  name: string;
  cwd: string;
  prompt: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  provider?: string;
  modelId?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMinutes: number;
  maxDailyRuns: number;
  emits: string[];
}

export interface AutomationConfig {
  version: 1;
  timezone: string;
  rules: AutomationRule[];
}

/** Server-only capability file. Never serialize this type to a browser response. */
export interface AutomationConnection {
  version: 1;
  instanceId: string;
  url: string;
  ownerKey: string;
  workerKey: string;
  sourceKey: string;
  pid: number;
  workerName: string;
  sourceName: string;
}

export interface AutomationUsage {
  input?: number;
  output?: number;
  cached?: number;
  cost?: number;
}

export interface AutomationRun {
  id: number;
  rule: string;
  state: string;
  attempts: number;
  createdAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
  notBefore: string;
  summary: string;
  error: string;
  session: string | null;
  stopping: boolean;
  usage: AutomationUsage | null;
  events: { source: string; type: string; subject: string; summary: string; link: string }[];
}

export interface AutomationCard {
  id: number;
  kind: string;
  title: string;
  text: string;
  options: string[];
  recommend?: number | null;
  state: string;
  version: number;
  [key: string]: unknown;
}

export interface AutomationState {
  now: string;
  timezone: string;
  runs: AutomationRun[];
  cards: AutomationCard[];
  recentCards: AutomationCard[];
  hasMore: boolean;
  nextBefore: number | null;
  totals: { running: number; queued: number; unknown: number; attention: number; [key: string]: unknown };
  lines: { id: string; next: string | null; [key: string]: unknown }[];
  spending: Record<"today" | "week", { rounds: number; tokens: number; cost: number; missingTokens: number; missingCost: number }>;
}

export interface AutomationSnapshot {
  available: boolean;
  reason?: string;
  instanceId?: string;
  config: AutomationConfig;
  state: AutomationState | null;
  worker: { suspended: boolean; activeRun: number | null; recoveryRun?: number | null; error?: string };
  owner?: { run?: number; [key: string]: unknown } | null;
}

export interface AutomationJob {
  run: number;
  token: string;
  attempt: number;
  rule: { name: string; cwd: string; prompt?: string; skill?: string; emits?: { source: string; types: string[] } };
  agent: { id: string; name: string; use: string; model?: string; effort?: string; access: string; timeout?: number };
  session: string | null;
  askFirst: string[];
  desktopRule?: AutomationRule;
  context: {
    events: { id: string; source: string; sourceName: string; type: string; subject: string; summary: string; detail: string; link: string; receivedAt: string; hops?: number }[];
    answers: unknown[];
    timers: unknown[];
    waiting: unknown[];
    open: unknown[];
    decided: unknown[];
  };
}

export interface AutomationResult {
  outcome: "done" | "nothing" | "failed" | "cancelled";
  summary?: string;
  error?: string;
  session?: string;
  usage?: AutomationUsage;
  [key: string]: unknown;
}
