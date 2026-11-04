import { hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import type { ProjectTrustStatus } from "@/lib/api-types";

function canonicalTrustCwd(cwd: string): string {
  try { return realpathSync.native(cwd); }
  catch { return cwd; }
}

export function getProjectTrustStatus(cwd: string, agentDir: string): ProjectTrustStatus {
  cwd = canonicalTrustCwd(cwd);
  const requiresTrust = Boolean(cwd) && hasTrustRequiringProjectResources(cwd);
  if (!requiresTrust) return { requiresTrust: false, trusted: true };

  return {
    requiresTrust: true,
    trusted: new ProjectTrustStore(agentDir).get(cwd) === true,
  };
}

export function trustProject(cwd: string, agentDir: string): ProjectTrustStatus {
  cwd = canonicalTrustCwd(cwd);
  const status = getProjectTrustStatus(cwd, agentDir);
  if (!status.requiresTrust) return status;

  new ProjectTrustStore(agentDir).set(cwd, true);
  return { requiresTrust: true, trusted: true };
}

/**
 * Gates repository-controlled resources before the SDK imports or executes them.
 * This includes project extensions, project package resources, prompts, and
 * `.agents/skills`; global resources remain available.
 */
export function projectTrustReloadOptions(
  cwd: string,
  agentDir: string,
): { resolveProjectTrust: () => Promise<boolean> } | undefined {
  cwd = canonicalTrustCwd(cwd);
  const status = getProjectTrustStatus(cwd, agentDir);
  if (!status.requiresTrust) return undefined;

  const trustStore = new ProjectTrustStore(agentDir);
  return { resolveProjectTrust: async () => trustStore.get(cwd) === true };
}
