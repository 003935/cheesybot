import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatInputCommandInteraction, Client, Message, ThreadChannel } from "discord.js";
import { createCapyClient, type CapyClient, type Fetch } from "../src/capy/client";
import { waitForRunEnd } from "../src/capy/watch";
import { Conversations } from "../src/conversations";
import { modelError, parseDirectives } from "../src/directives";
import { Progress, stepLine } from "../src/progress";
import { stores } from "../src/state";
import type { config } from "../src/config";

const settings = { capyModel: "openai/gpt-6-sol", capyProjectId: "project", threadUrl: "https://capy.ai/threads/{id}" } as typeof config;
const noop = async () => {};
const sse = (text: string) => new Response(text, { headers: { "Content-Type": "text/event-stream" } });
const state = () => {
  const path = mkdtempSync(join(tmpdir(), "cheesybot-"));
  return { store: stores(path), cleanup: () => rmSync(path, { recursive: true, force: true }), path };
};
const discord = { user: { id: "bot" } } as Client;

function fakeMessage(content: string, id = "message-1", mentioned = false) {
  const sent: unknown[] = [];
  const reactions: string[] = [];
  const channel = { id: "discord-thread", isThread: () => true,
    send: async (value: unknown) => { sent.push(value); return { id: `bot-${sent.length}`, edit: async (edit: unknown) => { sent.push(edit); } }; },
    setArchived: async () => {}, setLocked: async () => {}, };
  const message = { id, content, author: { bot: false, username: "Alice", globalName: null }, member: { displayName: "Alice", permissions: { has: () => true } },
    guildId: "guild", channel, attachments: { size: 0 }, mentions: { users: { has: () => mentioned } },
    react: async (emoji: string) => { reactions.push(emoji); },
    reply: async (value: unknown) => { sent.push(value); }, } as unknown as Message;
  return { message, channel: channel as unknown as ThreadChannel, sent, reactions };
}

test("observed stream fixture contributes tool texts and assistant first lines, never token fragments", async () => {
  const fixture = readFileSync("test/fixtures/stream-ping.sse", "utf8");
  const steps: string[] = [];
  let calls = 0;
  const fake: Fetch = async () => sse(++calls === 1 ? fixture : "event: done\ndata: {}\n\n");
  await waitForRunEnd(createCapyClient("key", "https://example.test/api/v1", fake), "t", noop,
    { onEvent: (frame) => { const step = stepLine(frame); if (step) steps.push(step); } });
  expect(steps).toContain("Inspecting repository instructions and command layout");
  expect(steps).toContain("Checking types, tests, and final changes");
  expect(steps.some((line) => line.startsWith("[PR #3]"))).toBe(true);
  expect(steps).not.toContain("PR");
});

test("progress coalesces changes within three seconds and flushes the latest state", async () => {
  let now = 0;
  let scheduled: (() => void) | undefined;
  const edits: string[] = [];
  const progress = new Progress(async (text) => { edits.push(text); }, "link", 0, () => now,
    ((fn: () => void) => { scheduled = fn; return 1; }) as unknown as typeof setTimeout,
    (() => { scheduled = undefined; }) as typeof clearTimeout);
  for (const text of ["one", "two", "three"]) progress.update({ event: "transcript", data: JSON.stringify({ source: "tool", text }) });
  expect(edits).toHaveLength(0);
  now = 3000;
  scheduled?.();
  await progress.finish("✅ Done");
  expect(edits.filter((text) => text.startsWith("🦫 Working"))).toHaveLength(1);
  expect(edits[0]).toContain("› three");
  expect(edits.at(-1)).toContain("✅ Done");
});

test("done while still working watches again; three extra rounds cap the watch", async () => {
  const local = state();
  try {
    let streams = 0;
    const sent: unknown[] = [];
    const channel = { send: async (value: unknown) => { sent.push(value); return { edit: async (value: unknown) => { sent.push(value); } }; } } as unknown as ThreadChannel;
    const capy = { stream: async () => { streams++; return sse("event: done\ndata: {}\n\n"); },
      getThread: async () => ({ status: "working" }) } as unknown as CapyClient;
    const service = new Conversations(discord, capy, local.store, settings);
    await service.startWatcher(channel, { capyThreadId: "thread", guildId: "guild", muted: false, archived: false, postedPrs: [] });
    expect(streams).toBe(4);
    expect(sent.some((item) => JSON.stringify(item).includes("⚠️ Lost"))).toBe(true);
  } finally { local.cleanup(); }
});

test("a PR card is posted once per linked thread across multiple runs", async () => {
  const local = state();
  try {
    const sent: Record<string, unknown>[] = [];
    const channel = { send: async (value: Record<string, unknown>) => { sent.push(value); return { edit: async () => {} }; } } as unknown as ThreadChannel;
    const capy = { stream: async () => sse("event: done\ndata: {}\n\n"), getThread: async () => ({ status: "idle" }),
      getTranscript: async () => [{ id: "a", source: "assistant", text: "Ready: https://github.com/a/b/pull/3", createdAt: "now" }] } as unknown as CapyClient;
    const service = new Conversations(discord, capy, local.store, settings);
    const link = { capyThreadId: "thread", guildId: "guild", muted: false, archived: false, postedPrs: [] as string[] };
    await service.startWatcher(channel, link);
    await service.startWatcher(channel, link);
    expect(sent.filter((item) => "embeds" in item)).toHaveLength(1);
    expect(link.postedPrs).toEqual(["https://github.com/a/b/pull/3"]);
  } finally { local.cleanup(); }
});

test("directives strip text and choose directive over guild over env", () => {
  expect(parseDirectives("model=anthropic/claude-sonnet-5 reasoning=high fix it", { modelId: "openai/gpt-6-sol", reasoningMode: "low" }, "other/model"))
    .toEqual({ text: "fix it", model: { modelId: "anthropic/claude-sonnet-5", reasoningMode: "high" } });
  expect(parseDirectives("fix it", { modelId: "guild/model" }, "env/model").model?.modelId).toBe("guild/model");
  expect(parseDirectives("fix it", {}, "env/model").model?.modelId).toBe("env/model");
  expect(() => parseDirectives("model=short fix it")).toThrow();
  expect(() => parseDirectives("reasoning=huge fix it")).toThrow();
});

test("model rejection reports disconnected and unknown models", () => {
  const disconnected = new Error("reject") as Error & { tag: string; detail: unknown };
  disconnected.tag = "ModelSelection.Rejected";
  disconnected.detail = { rejection: "not_connected", service: "codex" };
  expect(modelError(disconnected)).toContain("connected codex subscription");
  disconnected.detail = { message: "Unknown model", modelId: "bad/model" };
  expect(modelError(disconnected)).toContain("Unknown model bad/model");
});

test("message, interrupt and archive use the OpenAPI routes and receipt", async () => {
  const calls: { url: string; body?: unknown }[] = [];
  const fake: Fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body && JSON.parse(String(init.body)) });
    return Response.json({ id: "admitted", deduped: false });
  };
  const client = createCapyClient("key", "https://example.test/api/v1", fake);
  expect(await client.sendMessage("thread", { text: "hello", clientKey: "discord-id", delivery: "steer", model: { modelId: "openai/gpt-6-sol" } }))
    .toEqual({ id: "admitted", deduped: false });
  await client.interrupt("thread");
  await client.archive("thread");
  expect(calls.map((call) => call.url)).toEqual([
    "https://example.test/api/v1/threads/thread/message",
    "https://example.test/api/v1/threads/thread/interrupt",
    "https://example.test/api/v1/threads/thread/archive",
  ]);
  expect(calls[0]?.body).toEqual({ text: "hello", clientKey: "discord-id", delivery: "steer", model: { modelId: "openai/gpt-6-sol" } });
});

test("API model rejection preserves service and unknown-model details", async () => {
  const fake: Fetch = async () => Response.json({ _tag: "ModelSelection.Rejected", message: "Unknown model bad/model", candidates: [], modelId: "bad/model" }, { status: 400 });
  const client = createCapyClient("key", "https://example.test/api/v1", fake);
  try {
    await client.sendMessage("thread", { text: "hello", clientKey: "id" });
    throw new Error("Expected rejection");
  } catch (error) {
    expect(modelError(error)).toContain("Unknown model bad/model");
  }
});

test("state round-trips and startup resumes only working links", async () => {
  const local = state();
  try {
    local.store.threads.data.a = { capyThreadId: "working", guildId: "guild", muted: false, archived: false, postedPrs: [] };
    local.store.threads.data.b = { capyThreadId: "idle", guildId: "guild", muted: false, archived: false, postedPrs: [] };
    local.store.threads.data.c = { capyThreadId: "archived", guildId: "guild", muted: false, archived: true, postedPrs: [] };
    local.store.threads.save();
    expect(stores(local.path).threads.data.a?.capyThreadId).toBe("working");
    const fetched: string[] = [];
    const channel = fakeMessage("hello").channel;
    const client = { channels: { fetch: async (id: string) => { fetched.push(id); return channel; } }, user: { id: "bot" } } as unknown as Client;
    const capy = { getThread: async (id: string) => ({ id, status: id === "working" ? "working" : "idle" }) } as CapyClient;
    const service = new Conversations(client, capy, stores(local.path), settings);
    const watchers: string[] = [];
    service.startWatcher = async (_channel, link) => { watchers.push(link.capyThreadId); };
    await service.resume();
    expect(fetched).toEqual(["a"]);
    expect(watchers).toEqual(["working"]);
  } finally { local.cleanup(); }
});

test("a server mention creates a linked Discord thread with the message ID as requestId", async () => {
  const local = state();
  try {
    const created: unknown[] = [];
    const channel = fakeMessage("task").channel;
    const capy = { createThread: async (input: unknown) => { created.push(input); return { id: "capy-thread", status: "working" }; } } as unknown as CapyClient;
    const service = new Conversations(discord, capy, local.store, settings);
    service.startWatcher = async () => {};
    const message = { id: "discord-message", content: "<@bot> reasoning=low fix auth", guildId: "guild",
      author: { bot: false, username: "Alice" }, member: { displayName: "Alice", permissions: { has: () => true } },
      channel: { isThread: () => false }, mentions: { users: { has: () => true } },
      startThread: async (options: unknown) => { created.push(options); return channel; } } as unknown as Message;
    await service.mention(message);
    expect(created[0]).toMatchObject({ requestId: "discord-message", message: "[Discord · Alice]: fix auth", model: { modelId: "openai/gpt-6-sol", reasoningMode: "low" } });
    expect(created[1]).toEqual({ name: "fix auth" });
    expect(local.store.threads.data["discord-thread"]?.capyThreadId).toBe("capy-thread");
  } finally { local.cleanup(); }
});

test("Discord thread creation failure stops and archives the orphaned Capy run", async () => {
  const local = state();
  try {
    const actions: string[] = [];
    const capy = { createThread: async () => ({ id: "orphan", status: "working" }),
      interrupt: async () => { actions.push("interrupt"); }, archive: async () => { actions.push("archive"); } } as unknown as CapyClient;
    const service = new Conversations(discord, capy, local.store, settings);
    const replies: unknown[] = [];
    const message = { id: "msg", content: "<@bot> task", guildId: "guild", author: { bot: false, username: "Alice" }, member: { displayName: "Alice", permissions: { has: () => true } },
      channel: { isThread: () => false }, mentions: { users: { has: () => true } },
      startThread: async () => { throw new Error("Missing permissions"); }, reply: async (value: unknown) => { replies.push(value); } } as unknown as Message;
    const original = console.error;
    console.error = () => {};
    try { await service.mention(message); } finally { console.error = original; }
    expect(actions).toEqual(["interrupt", "archive"]);
    expect(JSON.stringify(replies)).toContain("Could not open a Discord thread");
  } finally { local.cleanup(); }
});

test("/capy-model saves a guild model and shows the current ephemeral setting", async () => {
  const local = state();
  try {
    const replies: unknown[] = [];
    const options = { model: "anthropic/claude-sonnet-5", effort: "xhigh" };
    const interaction = { guildId: "guild", memberPermissions: { has: () => true },
      options: { getString: (key: string) => options[key as keyof typeof options] ?? null },
      reply: async (reply: unknown) => { replies.push(reply); } } as unknown as ChatInputCommandInteraction;
    const service = new Conversations(discord, {} as CapyClient, local.store, settings);
    await service.modelSetting(interaction);
    expect(local.store.settings.data.guild).toEqual({ modelId: "anthropic/claude-sonnet-5", reasoningMode: "xhigh" });
    options.model = "";
    options.effort = "";
    await service.modelSetting(interaction);
    expect(replies.at(-1)).toMatchObject({ ephemeral: true, content: "Model: anthropic/claude-sonnet-5; effort: xhigh." });
  } finally { local.cleanup(); }
});

test("replies are prefixed, deduped by message ID and steer while working; muted and aside are skipped", async () => {
  const local = state();
  try {
    const link = { capyThreadId: "capy", guildId: "guild", muted: false, archived: false, postedPrs: [] };
    local.store.threads.data["discord-thread"] = link;
    const inputs: unknown[] = [];
    const capy = { getThread: async () => ({ status: "working" }), sendMessage: async (_id: string, input: unknown) => { inputs.push(input); return { id: "receipt", deduped: false }; } } as unknown as CapyClient;
    const service = new Conversations(discord, capy, local.store, settings);
    service.startWatcher = async () => {};
    const first = fakeMessage("reasoning=high fix auth", "msg-123");
    await service.reply(first.message);
    expect(inputs[0]).toMatchObject({ text: "[Discord · Alice]: fix auth", clientKey: "msg-123", delivery: "steer", model: { modelId: "openai/gpt-6-sol", reasoningMode: "high" } });
    expect(first.reactions).toEqual(["👀"]);
    link.muted = true;
    await service.reply(fakeMessage("not for Capy").message);
    await service.reply(fakeMessage("aside this is private", "aside", true).message);
    expect(inputs).toHaveLength(1);
    await service.reply(fakeMessage("<@bot> please look", "mentioned", true).message);
    expect(inputs).toHaveLength(2);
  } finally { local.cleanup(); }
});

test("stop interrupts, archive closes the link, and later messages are ignored", async () => {
  const local = state();
  try {
    const link = { capyThreadId: "capy", guildId: "guild", muted: false, archived: false, postedPrs: [] };
    local.store.threads.data["discord-thread"] = link;
    const actions: string[] = [];
    const capy = { getThread: async () => ({ status: "working" }), interrupt: async () => { actions.push("interrupt"); }, archive: async () => { actions.push("archive"); }, sendMessage: async () => { actions.push("send"); } } as unknown as CapyClient;
    const service = new Conversations(discord, capy, local.store, settings);
    await service.reply(fakeMessage("stop").message);
    await service.reply(fakeMessage("archive").message);
    await service.reply(fakeMessage("ignored").message);
    expect(actions).toEqual(["interrupt", "archive"]);
    expect(link.archived).toBe(true);
  } finally { local.cleanup(); }
});

test("stop on an idle thread does not label its next run stopped", async () => {
  const local = state();
  try {
    const link = { capyThreadId: "capy", guildId: "guild", muted: false, archived: false, postedPrs: [] };
    local.store.threads.data["discord-thread"] = link;
    const sent: string[] = [];
    const channel = { send: async (value: { content: string }) => { sent.push(value.content); return { edit: async (update: { content: string }) => { sent.push(update.content); } }; } } as unknown as ThreadChannel;
    const capy = { getThread: async () => ({ status: "idle" }), interrupt: async () => {}, stream: async () => sse("event: done\ndata: {}\n\n"),
      getTranscript: async () => [] } as unknown as CapyClient;
    const service = new Conversations(discord, capy, local.store, settings);
    await service.reply(fakeMessage("stop").message);
    await service.startWatcher(channel, link);
    expect(sent.some((line) => line.startsWith("✅ Done"))).toBe(true);
    expect(sent.some((line) => line.startsWith("⏹️ Stopped"))).toBe(false);
  } finally { local.cleanup(); }
});

test("follow-up while a watcher is posting results starts a new watcher", async () => {
  const local = state();
  try {
    const link = { capyThreadId: "capy", guildId: "guild", muted: false, archived: false, postedPrs: [] };
    local.store.threads.data["discord-thread"] = link;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let resolveEntered!: () => void;
    const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
    let streams = 0;
    const capy = { getThread: async () => ({ status: "idle" }), stream: async () => { streams++; return sse("event: done\ndata: {}\n\n"); },
      getTranscript: async () => { if (streams === 1) { resolveEntered(); await blocked; } return []; },
      sendMessage: async () => ({ id: "receipt", deduped: false }) } as unknown as CapyClient;
    const channel = fakeMessage("reply").channel;
    const service = new Conversations(discord, capy, local.store, settings);
    const first = service.startWatcher(channel, link);
    await entered;
    await service.reply(fakeMessage("another task").message);
    release();
    await first;
    for (let i = 0; i < 10 && streams < 2; i++) await Bun.sleep(1);
    expect(streams).toBe(2);
  } finally { local.cleanup(); }
});

test("only one watcher starts per Capy thread", async () => {
  const local = state();
  try {
    const link = { capyThreadId: "capy", guildId: "guild", muted: false, archived: false, postedPrs: [] };
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let sends = 0;
    const channel = { send: async () => { sends++; return { edit: async () => {} }; } } as unknown as ThreadChannel;
    const capy = { getThread: async () => ({ status: "working" }), stream: async () => { await pending; return sse("event: done\ndata: {}\n\n"); } } as unknown as CapyClient;
    const service = new Conversations(discord, capy, local.store, settings);
    const first = service.startWatcher(channel, link);
    expect(service.startWatcher(channel, link)).toBe(first);
    expect(service.watching("capy")).toBe(true);
    link.archived = true;
    release();
    await first;
    expect(sends).toBe(1);
  } finally { local.cleanup(); }
});
