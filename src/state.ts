import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelDefault } from "./directives";

export type Link = { capyThreadId: string; guildId: string; muted: boolean; archived: boolean; postedPrs: string[];
  prCards?: Record<string, { messageId: string; status: string }>; lastTranscriptId?: string };
export type GuildSettings = ModelDefault & { accessRoleId?: string };
export type NotifyState = { channels: Record<string, string>; threads: Record<string, { updatedAt: string; cursor?: string }>;
  seenUrls: Record<string, string[]>; initialized: boolean };

export function jsonStore<T>(path: string, initial: T): { data: T; save(): void } {
  let data = initial;
  try { data = JSON.parse(readFileSync(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return {
    data,
    save() {
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
      writeFileSync(temp, JSON.stringify(data, null, 2));
      renameSync(temp, path);
    },
  };
}

export function stores(directory = "data") {
  return {
    threads: jsonStore<Record<string, Link>>(`${directory}/threads.json`, {}),
    settings: jsonStore<Record<string, GuildSettings>>(`${directory}/settings.json`, {}),
    notify: jsonStore<NotifyState>(`${directory}/notify.json`, { channels: {}, threads: {}, seenUrls: {}, initialized: false }),
  };
}
