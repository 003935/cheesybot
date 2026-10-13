import { ActionRowBuilder, ButtonBuilder, ButtonStyle, DiscordjsErrorCodes, MessageFlags, PermissionFlagsBits,
  type ButtonInteraction, type ChatInputCommandInteraction, type Client, type Message, type ThreadChannel } from "discord.js";
import { CapyError, type CapyClient, type TranscriptMessage } from "./capy/client";
import { parseDirectives, modelError } from "./directives";
import { Progress } from "./progress";
import { waitForRunEnd } from "./capy/watch";
import { threadLink } from "./result";
import type { Link, stores } from "./state";
import type { config } from "./config";
import type { GitHubClient, PrRef } from "./github/client";

type Stores = ReturnType<typeof stores>;
type Settings = typeof config;
const mentions = { parse: [] as [] };
const quiet = { allowedMentions: mentions, flags: MessageFlags.SuppressEmbeds as const };
const prPattern = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

export class Conversations {
  private readonly watchers = new Map<string, Promise<void>>();
  private readonly pendingRestart = new Map<string, { channel: ThreadChannel; link: Link; force: boolean }>();
  private readonly settling = new Set<string>();
  private readonly stopped = new Set<string>();
  private refreshingPrCards = false;

  constructor(private readonly discord: Client, private readonly capy: CapyClient,
    private readonly state: Stores, private readonly settings: Settings, private readonly github?: GitHubClient) {}

  watching(id: string) { return this.watchers.has(id); }

  private name(message: Message): string {
    return message.member?.displayName ?? message.author.globalName ?? message.author.username;
  }

  private stripMention(text: string): string {
    const id = this.discord.user?.id;
    return id ? text.replace(new RegExp(`<@!?${id}>`, "g"), "").trim() : text.trim();
  }

  private allowed(guildId: string, permissions: { has(permission: bigint): boolean } | null | undefined,
    roles: { cache: { has(id: string): boolean } } | readonly string[] | undefined): boolean {
    if (permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
    const roleId = this.state.settings.data[guildId]?.accessRoleId;
    return !!roleId && (Array.isArray(roles) ? roles.includes(roleId) :
      !!roles && "cache" in roles && roles.cache.has(roleId));
  }

  private accessDescription(guildId: string): string {
    const roleId = this.state.settings.data[guildId]?.accessRoleId;
    return `Members with Manage Server${roleId ? ` or the <@&${roleId}> role` : ""} can use Capy.`;
  }

  private async create(task: string, name: string, requestId: string, guildId: string,
    openThread: (title: string) => Promise<ThreadChannel>, report: (text: string) => Promise<unknown>): Promise<boolean> {
    let parsed;
    try {
      parsed = parseDirectives(task, this.state.settings.data[guildId], this.settings.capyModel);
      if (!parsed.text) throw new Error("Give me a task after the mention or /capy command.");
    } catch (error) {
      await report((error as Error).message);
      return false;
    }
    let thread;
    try {
      thread = await this.capy.createThread({ requestId, projectId: this.settings.capyProjectId,
        message: `[Discord · ${name}]: ${parsed.text}`, title: parsed.text.slice(0, 80), model: parsed.model });
    } catch (error) {
      const ordinary = error instanceof CapyError ? {
        "capy/Unauthorized": "Bot is misconfigured.",
        "capy/Forbidden": "Bot is misconfigured.",
        "capy/PaidFeatureUnavailable": "Plan limit reached.",
        "capy/RateLimited": `Busy, try again in ${error.retryAfterSeconds ?? 2}s.`,
      }[error.tag] : undefined;
      await report(modelError(error) ?? ordinary ?? "Could not start the Capy task. Please try again later.");
      return false;
    }
    let discordThread: ThreadChannel;
    try {
      discordThread = await openThread(parsed.text.slice(0, 80));
    } catch (error) {
      console.error("Could not open Discord thread", error);
      // requestId dedupes on Capy's side, so another bot instance that already opened the thread shares this run.
      if ((error as { code?: unknown }).code === DiscordjsErrorCodes.MessageExistingThread) return false;
      try {
        await this.capy.interrupt(thread.id);
        await this.capy.archive(thread.id);
        await report("Could not open a Discord thread. The Capy run was stopped and archived; check the bot's thread permissions.");
      } catch (cleanupError) {
        console.error("Could not clean up orphaned Capy thread", cleanupError);
        await report(`Could not open a Discord thread. Check Capy thread ${thread.id} and the bot's thread permissions.`);
      }
      return false;
    }
    this.state.threads.data[discordThread.id] = {
      capyThreadId: thread.id, guildId, muted: false, archived: false, postedPrs: [],
    };
    this.state.threads.save();
    void this.startWatcher(discordThread, this.state.threads.data[discordThread.id]!);
    return true;
  }

  async mention(message: Message): Promise<void> {
    if (message.author.bot || !message.guildId || !this.discord.user || !message.mentions.users.has(this.discord.user.id)) return;
    if (message.channel.isThread()) {
      await this.reply(message);
      return;
    }
    if (!this.allowed(message.guildId, message.member?.permissions, message.member?.roles)) {
      await message.reply({ content: this.accessDescription(message.guildId), ...quiet });
      return;
    }
    const task = this.stripMention(message.content);
    await this.create(task, this.name(message), message.id, message.guildId,
      (title) => message.startThread({ name: title }),
      (text) => message.reply({ content: text, ...quiet }));
  }

  async slash(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.guildId && !this.allowed(interaction.guildId, interaction.memberPermissions,
      interaction.member?.roles)) {
      await interaction.reply({ content: this.accessDescription(interaction.guildId), ephemeral: true, ...quiet });
      return;
    }
    await interaction.deferReply();
    if (!interaction.guildId || interaction.channel?.isThread()) {
      await interaction.editReply({ content: "Use /capy in a server text channel so I can open a thread.", ...quiet });
      return;
    }
    const task = interaction.options.getString("task", true);
    const created = await this.create(task, interaction.member && "displayName" in interaction.member ? String(interaction.member.displayName) : interaction.user.globalName ?? interaction.user.username,
      interaction.id, interaction.guildId,
      async (title) => {
        await interaction.editReply({ content: "🦫 On it — opening a thread...", ...quiet });
        const reply = await interaction.fetchReply();
        return reply.startThread({ name: title });
      },
      (text) => interaction.editReply({ content: text, ...quiet }));
    if (created) await interaction.editReply({ content: "🦫 On it — continue in the thread below.", ...quiet });
  }

  async modelSetting(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "Manage Server permission is required.", ephemeral: true, ...quiet });
      return;
    }
    const model = interaction.options.getString("model");
    const effort = interaction.options.getString("effort");
    const current = this.state.settings.data[interaction.guildId] ?? {};
    if (model || effort) {
      try {
        const parsed = parseDirectives(`model=${model ?? current.modelId ?? this.settings.capyModel ?? ""}${effort ? ` reasoning=${effort}` : ""}`);
        if (!parsed.model) throw new Error("Choose a model first.");
        this.state.settings.data[interaction.guildId] = {
          ...current,
          modelId: parsed.model.modelId,
          reasoningMode: effort ? parsed.model.reasoningMode : current.reasoningMode,
        };
        this.state.settings.save();
      } catch (error) {
        await interaction.reply({ content: (error as Error).message, ephemeral: true, ...quiet });
        return;
      }
    }
    const selected = this.state.settings.data[interaction.guildId] ?? {};
    await interaction.reply({ content: `Model: ${selected.modelId ?? this.settings.capyModel ?? "default"}; effort: ${selected.reasoningMode ?? "default"}.`, ephemeral: true, ...quiet });
  }

  async accessSetting(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "Manage Server permission is required.", ephemeral: true, ...quiet });
      return;
    }
    const role = interaction.options.getRole("role");
    const reset = interaction.options.getBoolean("reset");
    if (role && reset) {
      await interaction.reply({ content: "Choose a role or reset, not both.", ephemeral: true, ...quiet });
      return;
    }
    if (role || reset) {
      const current = this.state.settings.data[interaction.guildId] ?? {};
      if (role) current.accessRoleId = role.id;
      else delete current.accessRoleId;
      this.state.settings.data[interaction.guildId] = current;
      this.state.settings.save();
    }
    await interaction.reply({ content: this.accessDescription(interaction.guildId), ephemeral: true, ...quiet });
  }

  async reply(message: Message): Promise<void> {
    if (message.author.bot || !message.channel.isThread()) return;
    const link = this.state.threads.data[message.channel.id];
    if (!link || link.archived) return;
    if (!this.allowed(link.guildId, message.member?.permissions, message.member?.roles)) return;
    const text = this.stripMention(message.content);
    if (/^aside(?:\s|$)/i.test(text)) return;
    const control = text.toLowerCase();
    try {
      if (control === "stop") {
        const status = await this.capy.getThread(link.capyThreadId);
        await this.capy.interrupt(link.capyThreadId);
        if (status.status === "working" && this.watchers.has(link.capyThreadId)) this.stopped.add(link.capyThreadId);
        await message.reply({ content: "⏹️ Stopped", ...quiet });
        return;
      }
      if (control === "mute" || control === "unmute") {
        link.muted = control === "mute";
        this.state.threads.save();
        await message.reply({ content: link.muted ? "🔇 Muted: mention me to talk to Capy" : "🔊 Unmuted", ...quiet });
        return;
      }
      if (control === "archive") {
        await this.capy.archive(link.capyThreadId);
        link.archived = true;
        this.state.threads.save();
        await message.reply({ content: "Thread archived.", ...quiet });
        await message.channel.setLocked(true);
        await message.channel.setArchived(true);
        return;
      }
      if (link.muted && !message.mentions.users.has(this.discord.user!.id)) return;
      const parsed = parseDirectives(text, this.state.settings.data[link.guildId], this.settings.capyModel);
      const attachment = message.attachments.size ? " [Attachment skipped.]" : "";
      if (!parsed.text && !attachment) return;
      const status = await this.capy.getThread(link.capyThreadId);
      await this.capy.sendMessage(link.capyThreadId, {
        text: `[Discord · ${this.name(message)}]: ${parsed.text}${attachment}`,
        clientKey: message.id,
        ...(status.status === "working" ? { delivery: "steer" as const } : {}),
        ...(parsed.model ? { model: parsed.model } : {}),
      });
      await message.react("👀");
      void this.startWatcher(message.channel, link, status.status !== "working");
    } catch (error) {
      await message.react("⚠️");
      await message.reply({ content: modelError(error) ?? (error instanceof Error && !("tag" in error) ? error.message : "Could not forward that message."), ...quiet });
    }
  }

  startWatcher(channel: ThreadChannel, link: Link, force = false): Promise<void> {
    const existing = this.watchers.get(link.capyThreadId);
    if (existing) {
      this.pendingRestart.set(link.capyThreadId, { channel, link, force: force || this.settling.has(link.capyThreadId) });
      return existing;
    }
    this.stopped.delete(link.capyThreadId);
    const job = this.watch(channel, link).catch((error: unknown) => console.error("Conversation watcher failed", error))
      .finally(() => {
        this.watchers.delete(link.capyThreadId);
        this.settling.delete(link.capyThreadId);
        const pending = this.pendingRestart.get(link.capyThreadId);
        this.pendingRestart.delete(link.capyThreadId);
        if (!pending || pending.link.archived) return;
        void (async () => {
          if (pending.force || (await this.capy.getThread(link.capyThreadId)).status === "working") {
            void this.startWatcher(pending.channel, pending.link);
          }
        })().catch((error: unknown) => console.error("Could not restart conversation watcher", error));
      });
    this.watchers.set(link.capyThreadId, job);
    return job;
  }

  private async watch(channel: ThreadChannel, link: Link): Promise<void> {
    const capyId = link.capyThreadId;
    const web = threadLink(capyId, this.settings.threadUrl);
    const started = Date.now();
    const status = await channel.send({ content: `🦫 Working · 0m 00s · ${web}`, ...quiet });
    const progress = new Progress((text) => status.edit({ content: text, ...quiet }), web, started);
    const since = link.lastTranscriptId;
    let outcome: "done" | "lost" = "lost";
    let latest = await this.capy.getThread(capyId);
    for (let round = 0; round < 4 && !link.archived; round++) {
      outcome = await waitForRunEnd(this.capy, capyId, Bun.sleep, {
        after: link.lastTranscriptId,
        onEvent: (frame) => {
          if (frame.event === "transcript" && frame.id && frame.id !== link.lastTranscriptId) {
            link.lastTranscriptId = frame.id;
            this.state.threads.save();
          }
          progress.update(frame);
        },
      });
      if (outcome === "lost") break;
      latest = await this.capy.getThread(capyId);
      if (latest.status !== "working") break;
      if (round === 3) outcome = "lost";
    }
    this.settling.add(capyId);
    if (link.archived) return;
    const stopped = this.stopped.delete(capyId);
    await progress.finish(stopped ? "⏹️ Stopped" : outcome === "lost" ? "⚠️ Lost" : latest.status === "failed" ? "❌ Failed" : "✅ Done");
    if (outcome === "lost") return;
    const transcript = await this.capy.getTranscript(capyId, since);
    const assistants = transcript.filter((item) => item.source === "assistant");
    const final = assistants.at(-1)?.text;
    if (final) {
      const suffix = `… ${web}`;
      await channel.send({ content: final.length > 1900 ? `${final.slice(0, Math.min(1900, 2000 - suffix.length))}${suffix}` : final,
        ...quiet });
    }
    await this.postPrs(channel, link, assistants);
  }

  private async postPrs(channel: ThreadChannel, link: Link, assistants: TranscriptMessage[]): Promise<void> {
    for (const item of assistants) for (const url of item.text.match(prPattern) ?? []) {
      if (link.postedPrs.includes(url)) continue;
      const number = url.split("/").at(-1);
      const components = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setLabel("View on GitHub").setStyle(ButtonStyle.Link).setURL(url),
        new ButtonBuilder().setCustomId(`pr:approve:${number}`).setLabel("Approve").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`pr:merge:${number}`).setLabel("Merge").setStyle(ButtonStyle.Primary));
      if (this.settings.threadUrl) components.addComponents(new ButtonBuilder().setLabel("Open in Capy").setStyle(ButtonStyle.Link)
        .setURL(this.settings.threadUrl.replace("{id}", encodeURIComponent(link.capyThreadId))));
      let review = "Unavailable (configure GITHUB_TOKEN)";
      if (this.github) {
        try { review = await this.github.capyReview(this.prRef(url)); }
        catch { review = "Unavailable (GitHub request failed)"; }
      }
      const card = await channel.send({ content: `PR #${number}: ${url}\nCapy review: ${review}`, components: [components], ...quiet });
      if (card.id) (link.prCards ??= {})[url] = { messageId: card.id, status: review };
      link.postedPrs.push(url);
      this.state.threads.save();
    }
  }

  private prRef(url: string): PrRef {
    const [, owner, repo, number] = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/.exec(url) ?? [];
    if (!owner || !repo || !number) throw new Error("Invalid PR URL");
    return { owner, repo, number: Number(number) };
  }

  async refreshPrCards(): Promise<void> {
    if (!this.github || this.refreshingPrCards) return;
    this.refreshingPrCards = true;
    try {
      for (const [channelId, link] of Object.entries(this.state.threads.data)) {
        if (link.archived) continue;
        for (const [url, card] of Object.entries(link.prCards ?? {})) {
          try {
            const status = await this.github.capyReview(this.prRef(url));
            if (status === card.status) continue;
            const channel = await this.discord.channels.fetch(channelId);
            if (!channel?.isThread()) continue;
            const message = await channel.messages.fetch(card.messageId);
            await message.edit({ content: `PR #${this.prRef(url).number}: ${url}\nCapy review: ${status}`, ...quiet });
            card.status = status;
            this.state.threads.save();
          } catch (error) { console.error(`Could not refresh PR card in ${channelId}`, error); }
        }
      }
    } finally {
      this.refreshingPrCards = false;
    }
  }

  async prAction(interaction: ButtonInteraction): Promise<void> {
    const match = /^pr:(approve|merge):([1-9]\d*)$/.exec(interaction.customId);
    if (!match) return;
    if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "Manage Server permission is required.", ephemeral: true, ...quiet });
      return;
    }
    const link = this.state.threads.data[interaction.channelId];
    const url = /^PR #\d+: (https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*)(?:\nCapy review: [^\n]+)?$/.exec(interaction.message.content)?.[1]
      ?? interaction.message.embeds[0]?.url;
    const parsed = url && /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/.exec(url);
    if (!link || link.archived || link.guildId !== interaction.guildId || !parsed || parsed[3] !== match[2] || !link.postedPrs.includes(url)) {
      await interaction.reply({ content: "This PR card is not linked to an active conversation.", ephemeral: true, ...quiet });
      return;
    }
    if (!this.github) {
      await interaction.reply({ content: "PR actions are unavailable: configure GITHUB_TOKEN.", ephemeral: true, ...quiet });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const ref: PrRef = { owner: parsed[1]!, repo: parsed[2]!, number: Number(match[2]) };
    try {
      const pr = await this.github.getPull(ref);
      if (pr.state !== "open" || !pr.head?.sha) {
        await interaction.editReply({ content: "Refused: the PR is not open.", ...quiet });
        return;
      }
      if (match[1] === "approve") {
        await this.github.approve(ref, pr.head.sha);
        await interaction.editReply({ content: `Approved PR #${ref.number}.`, ...quiet });
        return;
      }
      if (pr.mergeable !== true) {
        await interaction.editReply({ content: "Refused: the PR is not confirmed mergeable.", ...quiet });
        return;
      }
      const failure = await this.github.checkFailures(ref, pr.head.sha);
      if (failure) {
        await interaction.editReply({ content: `Refused: ${failure}`, ...quiet });
        return;
      }
      await this.github.merge(ref, pr.head.sha);
      await interaction.editReply({ content: `Merged PR #${ref.number}.`, ...quiet });
    } catch {
      await interaction.editReply({ content: "GitHub refused the action or could not verify the PR. Check its permissions, checks, and current state on GitHub.", ...quiet });
    }
  }

  async resume(): Promise<void> {
    for (const [id, link] of Object.entries(this.state.threads.data)) {
      if (link.archived) continue;
      try {
        if ((await this.capy.getThread(link.capyThreadId)).status !== "working") continue;
        const channel = await this.discord.channels.fetch(id);
        if (channel?.isThread()) void this.startWatcher(channel, link);
      } catch (error) { console.error(`Could not resume thread ${id}`, error); }
    }
  }
}
