import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export function createToolFreePromptPolicy(enabled = false) {
  const policy = { enabled };
  const extension: InlineExtension = {
    name: "desktop-tool-free-prompt",
    hidden: true,
    factory(pi) {
      pi.on("before_agent_start", (event) => {
        if (!policy.enabled) return;
        // Pi 0.86+ builds each request from transcript system messages. Use its
        // forced-prompt projection instead of writing the read-only Agent field.
        event.systemPromptOptions.selectedTools = [];
        return { systemPrompt: "" };
      });
    },
  };
  return { policy, extension };
}
