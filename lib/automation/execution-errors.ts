import type { AutomationSessionEvidence } from "./session-binding";

export class AutomationAuthenticationRequiredError extends Error {
  constructor(public readonly provider: string, public readonly status?: 401 | 403, public readonly session?: AutomationSessionEvidence) {
    super(`Restore authentication or provider access for ${provider} in model settings, then confirm to continue this automation.`);
  }
}

/** The SDK could not open an unchanged session before a prompt was submitted. */
export class AutomationSessionOpenError extends Error {
  constructor(public readonly cause: unknown) { super("The automation session could not be opened before execution"); }
}

export class AutomationExecutionUncertainError extends Error {
  constructor(public readonly cause?: unknown) { super("Automation execution did not confirm settlement; review before continuing"); }
}

/** SDK-owned transcript changes were verified; the business result is still unknown. */
export class AutomationRoundFailedError extends Error {
  constructor(public readonly cause: unknown, public readonly session: AutomationSessionEvidence) {
    super(cause instanceof Error ? cause.message : "Automation execution failed");
    if (cause instanceof Error && cause.name === "AbortError") this.name = "AbortError";
  }
}
