import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { CapyError, type CapyClient } from "../capy/client";
import { waitForRunEnd } from "../capy/watch";
import { resultFor, threadLink } from "../result";
import type { config } from "../config";

export const capyCommand = new SlashCommandBuilder()
  .setName("capy")
  .setDescription("Ask Capy to work on a coding task")
  .addStringOption((option) => option.setName("task").setDescription("The coding task").setRequired(true));

type Config = typeof config;

export async function handleCapy(interaction: ChatInputCommandInteraction, capy: CapyClient, settings: Config): Promise<void> {
  await interaction.deferReply();
  const task = interaction.options.getString("task", true);
  let thread;
  try {
    thread = await capy.createThread({
      requestId: interaction.id,
      projectId: settings.capyProjectId,
      message: task,
      title: task.slice(0, 80),
    });
  } catch (error) {
    const message = error instanceof CapyError ? {
      "capy/Unauthorized": "Bot is misconfigured.",
      "capy/Forbidden": "Bot is misconfigured.",
      "capy/PaidFeatureUnavailable": "Plan limit reached.",
      "capy/RateLimited": `Busy, try again in ${error.retryAfterSeconds ?? 2}s.`,
    }[error.tag] : undefined;
    await interaction.editReply(message ?? "Could not start the Capy task. Please try again later.");
    return;
  }

  const link = threadLink(thread.id, settings.threadUrl);
  await interaction.editReply(`🦫 On it: ${link}`);
  const reply = await interaction.fetchReply();
  const channel = interaction.channel;
  if (!channel || !("send" in channel)) throw new Error("Cannot send to this Discord channel");

  void (async () => {
    let text: string;
    try {
      const outcome = await waitForRunEnd(capy, thread.id);
      if (outcome === "lost") {
        text = resultFor(thread, [], link, true).text;
      } else {
        const [latest, transcript] = await Promise.all([capy.getThread(thread.id), capy.getTranscript(thread.id)]);
        text = resultFor(latest, transcript, link).text;
      }
    } catch (error) {
      console.error("Could not retrieve Capy result", error);
      text = `⚠️ Could not retrieve the result: ${link}`;
    }
    await channel.send({ content: text, reply: { messageReference: reply.id, failIfNotExists: false }, allowedMentions: { parse: [] } });
  })().catch((error: unknown) => console.error("Could not post Capy result", error));
}
