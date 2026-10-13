import { MessageFlags, type Client } from "discord.js";
import type { CapyClient } from "../capy/client";
import type { NotifyState } from "../state";

const prPattern = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

export class NotifyPoller {
  private running = false;

  constructor(private readonly discord: Client, private readonly capy: CapyClient, private readonly projectId: string,
    private readonly store: { data: NotifyState; save(): void }) {}

  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const baseline = !this.store.data.initialized;
      let cursor: string | undefined;
      const pages = new Set<string>();
      do {
        const page = await this.capy.listThreads(this.projectId, cursor);
        for (const thread of page.items) {
          if (!thread.updatedAt) continue;
          const previous = this.store.data.threads[thread.id];
          if (previous?.updatedAt === thread.updatedAt) continue;
          let after = previous?.cursor;
          const urls: string[] = [];
          const visited = new Set<string>();
          while (true) {
            const messages = await this.capy.getTranscriptPage(thread.id, after);
            for (const item of messages.items) {
              if (item.source === "assistant") urls.push(...item.text.match(prPattern) ?? []);
            }
            if (!messages.cursor) {
              after = messages.items.at(-1)?.id ?? after;
              break;
            }
            if (messages.cursor === after || visited.has(messages.cursor)) throw new Error("Notify transcript pagination stalled");
            visited.add(messages.cursor);
            after = messages.cursor;
          }
          if (baseline) {
            const seen = this.store.data.seenUrls["*"] ??= [];
            for (const url of urls) if (!seen.includes(url)) seen.push(url);
            this.store.save();
          }
          for (const [guildId, channelId] of Object.entries(this.store.data.channels)) {
            const seen = this.store.data.seenUrls[guildId] ??= [];
            for (const url of urls) {
              if (seen.includes(url)) continue;
              if (!baseline) {
                const channel = await this.discord.channels.fetch(channelId);
                if (!channel?.isSendable()) throw new Error("Notify channel is unavailable");
                await channel.send({ content: `PR #${url.split("/").at(-1)}: ${url}`,
                  allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds });
              }
              seen.push(url);
              this.store.save();
            }
          }
          this.store.data.threads[thread.id] = { updatedAt: thread.updatedAt, ...(after ? { cursor: after } : {}) };
          this.store.save();
        }
        if (!page.cursor) break;
        if (page.cursor === cursor || pages.has(page.cursor)) throw new Error("Notify thread pagination stalled");
        pages.add(page.cursor);
        cursor = page.cursor;
      } while (cursor);
      if (baseline) {
        this.store.data.initialized = true;
        this.store.save();
      }
    } finally {
      this.running = false;
    }
  }
}
