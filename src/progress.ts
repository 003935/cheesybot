import type { Frame } from "./capy/sse";

export function stepLine(frame: Frame): string | undefined {
  if (frame.event !== "transcript") return;
  let value: unknown;
  try { value = JSON.parse(frame.data); } catch { return; }
  if (!value || typeof value !== "object") return;
  const item = value as Record<string, unknown>;
  if (typeof item.text !== "string" || !["tool", "assistant"].includes(String(item.source))) return;
  const text = item.source === "assistant" ? item.text.split("\n")[0] : item.text;
  return text?.trim().slice(0, 120) || undefined;
}

export class Progress {
  readonly steps: string[] = [];
  private lastText = "";
  private pending?: ReturnType<typeof setTimeout>;
  private lastEdit: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly edit: (text: string) => Promise<unknown>, private readonly link: string,
    private readonly started: number, private readonly now: () => number = Date.now,
    private readonly schedule: typeof setTimeout = setTimeout, private readonly cancel: typeof clearTimeout = clearTimeout) {
    this.lastEdit = started;
  }

  private render(state: string): string {
    const seconds = Math.max(0, Math.floor((this.now() - this.started) / 1000));
    const elapsed = `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
    return `${state}${state === "🦫 Working" || state === "✅ Done" ? ` · ${elapsed}` : ""} · ${this.link}${this.steps.length ? `\n${this.steps.slice(-5).map((step) => `› ${step}`).join("\n")}` : ""}`;
  }

  private flush(state = "🦫 Working") {
    if (this.pending) this.cancel(this.pending);
    this.pending = undefined;
    const text = this.render(state);
    if (text === this.lastText) return this.queue;
    this.lastText = text;
    this.lastEdit = this.now();
    this.queue = this.queue.then(() => this.edit(text).then(() => {}));
    return this.queue;
  }

  update(frame: Frame) {
    const step = stepLine(frame);
    if (!step) return;
    this.steps.push(step);
    if (this.now() - this.lastEdit >= 3000) void this.flush();
    else if (!this.pending) this.pending = this.schedule(() => { void this.flush(); }, 3000 - (this.now() - this.lastEdit));
  }

  async finish(state: "✅ Done" | "❌ Failed" | "⏹️ Stopped" | "⚠️ Lost") {
    await this.flush(state);
  }
}
