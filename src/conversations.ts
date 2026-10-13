import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits,
  type ChatInputCommandInteraction, type Client, type Message, type ThreadChannel } from "discord.js";
import { CapyError, type CapyClient, type TranscriptMessage } from "./capy/client";
import { parseDirectives, modelError } from "./directives";
import { Progress } from "./progress";
import { waitForRunEnd } from "./capy/watch";
import { threadLink } from "./result";
import type { Link, stores } from "./state";
import type { config } from "./config";

type Stores = ReturnType<typeof stores>;
type Settings = typeof config;
const mentions = { parse: [] as [] };
const prPattern = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

export class Conversations {
  private readonly watchers = new Map<string, Promise<void>>();
  private readonly stopped = new Set<string>();

  constructor(private readonly discord: Client, private readonly capy: CapyClient,
    private readonly state: Stores, private readonly settings: Settings) {}

  watching(id: string) { return this.watchers.has(id); }

  private name(message: Message): string {
    return message.member?.displayName ?? message.author.globalName ?? message.author.username;
  }

  private stripMention(text: string): string {
    const id = this.discord.user?.id;
    return id ? text.replace(new RegExp(`<@!?${id}>`, "g"), "").trim() : text.trim();
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
    const discordThread = await openThread(parsed.text.slice(0, 80));
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
    const task = this.stripMention(message.content);
    await this.create(task, this.name(message), message.id, message.guildId,
      (title) => message.startThread({ name: title }),
      (text) => message.reply({ content: text, allowedMentions: mentions }));
  }

  async slash(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    if (!interaction.guildId || interaction.channel?.isThread()) {
      await interaction.editReply("Use /capy in a server text channel so I can open a thread.");
      return;
    }
    const task = interaction.options.getString("task", true);
    const created = await this.create(task, interaction.member && "displayName" in interaction.member ? String(interaction.member.displayName) : interaction.user.globalName ?? interaction.user.username,
      interaction.id, interaction.guildId,
      async (title) => {
        await interaction.editReply("🦫 On it — opening a thread...");
        const reply = await interaction.fetchReply();
        return reply.startThread({ name: title });
      },
      (text) => interaction.editReply(text));
    if (created) await interaction.editReply("🦫 On it — continue in the thread below.");
  }

  async modelSetting(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "Manage Server permission is required.", ephemeral: true });
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
          modelId: parsed.model.modelId,
          reasoningMode: effort ? parsed.model.reasoningMode : current.reasoningMode,
        };
        this.state.settings.save();
      } catch (error) {
        await interaction.reply({ content: (error as Error).message, ephemeral: true });
        return;
      }
    }
    const selected = this.state.settings.data[interaction.guildId] ?? {};
    await interaction.reply({ content: `Model: ${selected.modelId ?? this.settings.capyModel ?? "default"}; effort: ${selected.reasoningMode ?? "default"}.`, ephemeral: true });
  }

  async reply(message: Message): Promise<void> {
    if (message.author.bot || !message.channel.isThread()) return;
    const link = this.state.threads.data[message.channel.id];
    if (!link || link.archived) return;
    const text = this.stripMention(message.content);
    if (/^aside(?:\s|$)/i.test(text)) return;
    const control = text.toLowerCase();
    try {
      if (control === "stop") {
        await this.capy.interrupt(link.capyThreadId);
        this.stopped.add(link.capyThreadId);
        await message.reply({ content: "⏹️ Stopped", allowedMentions: mentions });
        return;
      }
      if (control === "mute" || control === "unmute") {
        link.muted = control === "mute";
        this.state.threads.save();
        await message.reply({ content: link.muted ? "🔇 Muted: mention me to talk to Capy" : "🔊 Unmuted", allowedMentions: mentions });
        return;
      }
      if (control === "archive") {
        await this.capy.archive(link.capyThreadId);
        link.archived = true;
        this.state.threads.save();
        await message.reply({ content: "Thread archived.", allowedMentions: mentions });
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
      void this.startWatcher(message.channel, link);
    } catch (error) {
      await message.react("⚠️");
      await message.reply({ content: modelError(error) ?? (error instanceof Error && !("tag" in error) ? error.message : "Could not forward that message."), allowedMentions: mentions });
    }
  }

  startWatcher(channel: ThreadChannel, link: Link): Promise<void> {
    const existing = this.watchers.get(link.capyThreadId);
    if (existing) return existing;
    const job = this.watch(channel, link).catch((error: unknown) => console.error("Conversation watcher failed", error))
      .finally(() => { this.watchers.delete(link.capyThreadId); });
    this.watchers.set(link.capyThreadId, job);
    return job;
  }

  private async watch(channel: ThreadChannel, link: Link): Promise<void> {
    const capyId = link.capyThreadId;
    const web = threadLink(capyId, this.settings.threadUrl);
    const started = Date.now();
    const status = await channel.send({ content: `🦫 Working · 0m 00s · ${web}`, allowedMentions: mentions });
    const progress = new Progress((text) => status.edit({ content: text, allowedMentions: mentions }), web, started);
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
        allowedMentions: mentions });
    }
    await this.postPrs(channel, link, assistants);
  }

  private async postPrs(channel: ThreadChannel, link: Link, assistants: TranscriptMessage[]): Promise<void> {
    for (const item of assistants) for (const url of item.text.match(prPattern) ?? []) {
      if (link.postedPrs.includes(url)) continue;
      const number = url.split("/").at(-1);
      const components = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setLabel("View on GitHub").setStyle(ButtonStyle.Link).setURL(url));
      if (this.settings.threadUrl) components.addComponents(new ButtonBuilder().setLabel("Open in Capy").setStyle(ButtonStyle.Link)
        .setURL(this.settings.threadUrl.replace("{id}", encodeURIComponent(link.capyThreadId))));
      await channel.send({ embeds: [new EmbedBuilder().setTitle(`PR #${number}`).setURL(url)], components: [components], allowedMentions: mentions });
      link.postedPrs.push(url);
      this.state.threads.save();
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
