import type { Thread, TranscriptMessage } from "./capy/client";

export type Result = { kind: "pr" | "failed" | "needs_input" | "lost"; text: string };

export function threadLink(id: string, template?: string): string {
  return template ? template.replace("{id}", encodeURIComponent(id)) : `Capy thread ${id}`;
}

export function resultFor(thread: Thread, transcript: TranscriptMessage[], link: string, lost = false): Result {
  if (lost) return { kind: "lost", text: `⚠️ Lost track of this run: ${link}` };
  const assistants = transcript.filter((item) => item.source === "assistant");
  const matches = assistants.flatMap((item) => item.text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g) ?? []);
  const url = matches.at(-1);
  if (url) return { kind: "pr", text: `✅ PR ready: ${url}` };
  if (thread.status === "failed") return { kind: "failed", text: `❌ Run failed: ${link}` };
  const last = assistants.at(-1)?.text.slice(0, 1500) || "No response yet.";
  return { kind: "needs_input", text: `🤔 Capy needs input: ${last} ${link}` };
}
