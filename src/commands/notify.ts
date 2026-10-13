import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import type { NotifyState } from "../state";

export const notifyCommand = new SlashCommandBuilder()
  .setName("capy-notify")
  .setDescription("Post project pull requests to a channel")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addChannelOption((option) => option.setName("channel").setDescription("Channel for project PRs").setRequired(true));

export async function handleNotify(interaction: ChatInputCommandInteraction,
  store: { data: NotifyState; save(): void }): Promise<void> {
  const quiet = { ephemeral: true, allowedMentions: { parse: [] as [] }, flags: MessageFlags.SuppressEmbeds as const };
  if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "Manage Server permission is required.", ...quiet });
    return;
  }
  const channel = interaction.options.getChannel("channel", true);
  if (!("send" in channel) || typeof channel.send !== "function" || channel.isThread()) {
    await interaction.reply({ content: "Choose a text channel I can post to.", ...quiet });
    return;
  }
  store.data.channels[interaction.guildId] = channel.id;
  store.data.seenUrls[interaction.guildId] ??= [...new Set(Object.values(store.data.seenUrls).flat())];
  store.save();
  await interaction.reply({ content: `New project PRs will be posted in <#${channel.id}>.`, ...quiet });
}
