import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";

export const pingCommand = new SlashCommandBuilder()
  .setName("ping")
  .setDescription("Show the bot's Discord latency");

export async function handlePing(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({ content: `pong 🐱 (${Math.round(interaction.client.ws.ping)}ms)`,
    allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds });
}
