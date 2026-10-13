import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionFlagsBits, type ChatInputCommandInteraction, type Client, type Message } from "discord.js";
import type { CapyClient } from "../src/capy/client";
import { accessCommand } from "../src/commands/capy";
import { Conversations } from "../src/conversations";
import { stores } from "../src/state";
import type { config } from "../src/config";

const discord = { user: { id: "bot" } } as Client;
const configValues = { capyProjectId: "project" } as typeof config;
const admin = { displayName: "Admin", permissions: { has: (bit: bigint) => bit === PermissionFlagsBits.ManageGuild }, roles: { cache: { has: (_id: string) => false } } };
const member = (roleId?: string) => ({ displayName: "Member", permissions: { has: () => false }, roles: { cache: { has: (id: string) => id === roleId } } });

function interaction(user: typeof admin, values: { role?: string; reset?: boolean; model?: string; effort?: string; task?: string } = {}) {
  const replies: unknown[] = [];
  let deferred = false;
  const fake = { id: "interaction", guildId: "guild", member: user, memberPermissions: user.permissions,
    channel: { isThread: () => false }, user: { username: user.displayName },
    options: { getRole: () => values.role ? { id: values.role } : null,
      getBoolean: () => values.reset ?? null, getString: (key: string) => values[key as "model" | "effort" | "task"] ?? null },
    reply: async (value: unknown) => { replies.push(value); }, deferReply: async () => { deferred = true; },
    editReply: async (value: unknown) => { replies.push(value); },
  } as unknown as ChatInputCommandInteraction;
  return { fake, replies, get deferred() { return deferred; } };
}

function message(user: typeof admin, thread: boolean, content: string) {
  const replies: unknown[] = [];
  const reactions: string[] = [];
  const channel = { id: "thread", isThread: () => thread, setLocked: async () => {}, setArchived: async () => {} };
  const fake = { id: "message", guildId: "guild", content, author: { bot: false, username: user.displayName }, member: user,
    channel, mentions: { users: { has: () => true } }, attachments: { size: 0 },
    reply: async (value: unknown) => { replies.push(value); }, react: async (value: string) => { reactions.push(value); },
  } as unknown as Message;
  return { fake, replies, reactions };
}

test("/capy-access requires Manage Server and registers role and reset options", async () => {
  const path = mkdtempSync(join(tmpdir(), "access-"));
  try {
    const command = accessCommand.toJSON();
    expect(command.default_member_permissions).toBe(PermissionFlagsBits.ManageGuild.toString());
    expect(command.options?.map((option) => option.name)).toEqual(["role", "reset"]);
    const store = stores(path);
    const service = new Conversations(discord, {} as CapyClient, store, configValues);
    const denied = interaction(member());
    await service.accessSetting(denied.fake);
    expect(denied.replies).toEqual([{ content: "Manage Server permission is required.", ephemeral: true }]);
    expect(store.settings.data.guild).toBeUndefined();
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("admin and configured role can start tasks; others get a short or ephemeral denial", async () => {
  const path = mkdtempSync(join(tmpdir(), "access-"));
  try {
    const store = stores(path);
    const created: string[] = [];
    const capy = { createThread: async (input: { requestId: string }) => { created.push(input.requestId); return { id: "capy" }; } } as unknown as CapyClient;
    const service = new Conversations(discord, capy, store, configValues);
    service.startWatcher = async () => {};
    const noAccess = message(member(), false, "<@bot> task");
    await service.mention(noAccess.fake);
    expect(noAccess.replies).toEqual([{ content: "Members with Manage Server can use Capy.", allowedMentions: { parse: [] } }]);
    const slashDenied = interaction(member());
    await service.slash(slashDenied.fake);
    expect(slashDenied.deferred).toBe(false);
    expect(slashDenied.replies).toEqual([{ content: "Members with Manage Server can use Capy.", ephemeral: true }]);

    const adminTask = message(admin, false, "<@bot> task");
    (adminTask.fake as unknown as { startThread: (value: unknown) => Promise<unknown> }).startThread = async () => ({ id: "new-thread" });
    await service.mention(adminTask.fake);
    expect(created).toEqual(["message"]);

    const access = interaction(admin, { role: "role-1" });
    await service.accessSetting(access.fake);
    expect(access.replies[0]).toMatchObject({ ephemeral: true, content: "Members with Manage Server or the <@&role-1> role can use Capy." });
    const allowed = message(member("role-1"), false, "<@bot> task");
    (allowed.fake as unknown as { startThread: (value: unknown) => Promise<unknown> }).startThread = async () => ({ id: "another-thread" });
    await service.mention(allowed.fake);
    expect(created).toEqual(["message", "message"]);
    const slashAllowed = interaction(member("role-1"), { task: "task" });
    (slashAllowed.fake as unknown as { fetchReply: () => Promise<unknown> }).fetchReply = async () => ({ startThread: async () => ({ id: "slash-thread" }) });
    await service.slash(slashAllowed.fake);
    expect(slashAllowed.deferred).toBe(true);
    expect(created).toEqual(["message", "message", "interaction"]);
    const denied = message(member("wrong-role"), false, "<@bot> task");
    await service.mention(denied.fake);
    expect(denied.replies[0]).toMatchObject({ content: "Members with Manage Server or the <@&role-1> role can use Capy." });
    expect(created).toHaveLength(3);
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("linked replies and controls silently ignore members without access", async () => {
  const path = mkdtempSync(join(tmpdir(), "access-"));
  try {
    const store = stores(path);
    store.settings.data.guild = { accessRoleId: "role-1" };
    const link = { capyThreadId: "capy", guildId: "guild", muted: false, archived: false, postedPrs: [] };
    store.threads.data.thread = link;
    const actions: string[] = [];
    const capy = { getThread: async () => ({ status: "idle" }), sendMessage: async () => { actions.push("send"); },
      interrupt: async () => { actions.push("interrupt"); }, archive: async () => { actions.push("archive"); } } as unknown as CapyClient;
    const service = new Conversations(discord, capy, store, configValues);
    service.startWatcher = async () => {};
    for (const text of ["task", "stop", "mute", "unmute", "archive", "model=provider/model task"]) {
      const blocked = message(member("wrong-role"), true, text);
      await service.mention(blocked.fake);
      expect(blocked.replies).toEqual([]);
      expect(blocked.reactions).toEqual([]);
    }
    expect(actions).toEqual([]);
    expect(link).toMatchObject({ muted: false, archived: false });
    await service.reply(message(member("role-1"), true, "task").fake);
    await service.reply(message(member("role-1"), true, "mute").fake);
    await service.reply(message(admin, true, "stop").fake);
    await service.reply(message(admin, true, "archive").fake);
    expect(actions).toEqual(["send", "interrupt", "archive"]);
    expect(link).toMatchObject({ muted: true, archived: true });
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("access reset and model changes persist without overwriting each other", async () => {
  const path = mkdtempSync(join(tmpdir(), "access-"));
  try {
    const store = stores(path);
    const service = new Conversations(discord, {} as CapyClient, store, configValues);
    await service.accessSetting(interaction(admin, { role: "role-1" }).fake);
    await service.modelSetting(interaction(admin, { model: "provider/model" }).fake);
    expect(store.settings.data.guild?.accessRoleId).toBe("role-1");
    expect(store.settings.data.guild?.modelId).toBe("provider/model");
    expect(stores(path).settings.data.guild?.accessRoleId).toBe("role-1");
    const shown = interaction(admin);
    await service.accessSetting(shown.fake);
    expect(shown.replies[0]).toMatchObject({ content: "Members with Manage Server or the <@&role-1> role can use Capy." });
    const conflict = interaction(admin, { role: "role-2", reset: true });
    await service.accessSetting(conflict.fake);
    expect(store.settings.data.guild?.accessRoleId).toBe("role-1");
    const reset = interaction(admin, { reset: true });
    await service.accessSetting(reset.fake);
    expect(reset.replies[0]).toMatchObject({ content: "Members with Manage Server can use Capy." });
    expect(JSON.parse(readFileSync(join(path, "settings.json"), "utf8")).guild).toEqual(store.settings.data.guild);
    expect(stores(path).settings.data.guild?.accessRoleId).toBeUndefined();
  } finally { rmSync(path, { recursive: true, force: true }); }
});
