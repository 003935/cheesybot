import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageFlags, PermissionFlagsBits, type ChatInputCommandInteraction, type Client } from "discord.js";
import { createCapyClient, type Fetch } from "../src/capy/client";
import { handleNotify, notifyCommand } from "../src/commands/notify";
import { NotifyPoller } from "../src/notify/poller";
import { stores } from "../src/state";

const oldUrl = "https://github.com/acme/app/pull/1";
const newUrl = "https://github.com/acme/app/pull/2";
const id1 = "01AAAAAAAAAAAAAAAAAAAAAAAA";
const id2 = "01BBBBBBBBBBBBBBBBBBBBBBBB";

function interaction(admin: boolean, sendable = true) {
  const replies: unknown[] = [];
  const fake = { guildId: "guild", memberPermissions: { has: (bit: bigint) => admin && bit === PermissionFlagsBits.ManageGuild },
    options: { getChannel: () => ({ id: "feed", isThread: () => !sendable,
      ...(sendable ? { send: async () => {} } : {}) }) }, reply: async (reply: unknown) => { replies.push(reply); } } as unknown as ChatInputCommandInteraction;
  return { fake, replies };
}

test("/capy-notify requires Manage Server and a sendable channel", async () => {
  const path = mkdtempSync(join(tmpdir(), "notify-"));
  try {
    const store = stores(path).notify;
    expect(notifyCommand.toJSON().default_member_permissions).toBe(PermissionFlagsBits.ManageGuild.toString());
    expect(notifyCommand.toJSON().options?.[0]?.name).toBe("channel");
    const denied = interaction(false);
    await handleNotify(denied.fake, store);
    expect(denied.replies).toEqual([{ content: "Manage Server permission is required.", ephemeral: true,
      allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds }]);
    const invalid = interaction(true, false);
    await handleNotify(invalid.fake, store);
    expect(invalid.replies[0]).toMatchObject({ content: "Choose a text channel I can post to." });
    expect(store.data.channels).toEqual({});
    const allowed = interaction(true);
    await handleNotify(allowed.fake, store);
    expect(allowed.replies[0]).toMatchObject({ content: "New project PRs will be posted in <#feed>." });
    expect(stores(path).notify.data.channels).toEqual({ guild: "feed" });
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("poller pages threads and messages, baselines old PRs, and persists deduplication", async () => {
  const path = mkdtempSync(join(tmpdir(), "notify-"));
  try {
    const calls: string[] = [];
    let changed = false;
    const fake: Fetch = async (input) => {
      const url = new URL(String(input));
      calls.push(url.pathname + url.search);
      if (url.pathname.endsWith("/threads")) return Response.json(url.searchParams.has("cursor") ?
        { items: [{ id: "b", updatedAt: changed ? "new" : "old" }], cursor: null } :
        { items: [{ id: "a", updatedAt: "old" }], cursor: "123:b" });
      if (url.pathname.endsWith("/a/messages")) return Response.json({ items: [{ id: id1, source: "assistant", text: oldUrl }], cursor: null, beforeCursor: null });
      if (url.searchParams.has("after")) return Response.json({ items: [{ id: id2, source: "assistant", text: `${newUrl} ${newUrl}` }], cursor: null, beforeCursor: null });
      return Response.json(changed ? { items: [{ id: id1, source: "assistant", text: oldUrl }], cursor: id1, beforeCursor: null } :
        { items: [{ id: id1, source: "assistant", text: oldUrl }], cursor: null, beforeCursor: null });
    };
    const sent: unknown[] = [];
    const discord = { channels: { fetch: async (id: string) => {
      expect(id).toBe("feed");
      return { isSendable: () => true, send: async (message: unknown) => { sent.push(message); } };
    } } } as unknown as Client;
    const capy = createCapyClient("key", "https://example.test/api/v1", fake);
    const store = stores(path).notify;
    const poller = new NotifyPoller(discord, capy, "project", store);
    await poller.poll();
    expect(sent).toEqual([]);
    expect(store.data.initialized).toBe(true);
    expect(store.data.seenUrls["*"]).toEqual([oldUrl]);
    await handleNotify(interaction(true).fake, store);
    changed = true;
    await poller.poll();
    expect(sent).toEqual([{ content: `PR #2: ${newUrl}`, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds }]);
    expect(calls.some((url) => url.includes(`/b/messages?after=${id1}`))).toBe(true);
    await new NotifyPoller(discord, capy, "project", stores(path).notify).poll();
    expect(sent).toHaveLength(1);
    expect(calls.filter((url) => url.includes("/a/messages"))).toHaveLength(1);
    expect(calls.some((url) => url.includes("projectId=project&cursor=123%3Ab"))).toBe(true);
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("failed sends leave a thread eligible for retry", async () => {
  const path = mkdtempSync(join(tmpdir(), "notify-"));
  try {
    const store = stores(path).notify;
    store.data.initialized = true;
    store.data.channels.guild = "feed";
    let fail = true;
    const sent: unknown[] = [];
    const discord = { channels: { fetch: async () => ({ isSendable: () => true, send: async (value: unknown) => {
      if (fail) throw new Error("Discord unavailable");
      sent.push(value);
    } }) } } as unknown as Client;
    const capy = createCapyClient("key", "https://example.test/api/v1", async (input) => Response.json(String(input).endsWith("/threads?projectId=project") ?
      { items: [{ id: "a", updatedAt: "now" }], cursor: null } :
      { items: [{ id: id1, source: "assistant", text: newUrl }], cursor: null, beforeCursor: null }));
    const poller = new NotifyPoller(discord, capy, "project", store);
    await expect(poller.poll()).rejects.toThrow("Discord unavailable");
    expect(stores(path).notify.data.threads.a).toBeUndefined();
    fail = false;
    await poller.poll();
    expect(sent).toHaveLength(1);
    expect(stores(path).notify.data.threads.a?.cursor).toBe(id1);
  } finally { rmSync(path, { recursive: true, force: true }); }
});
