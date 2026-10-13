import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";

export const capyCommand = new SlashCommandBuilder()
  .setName("capy")
  .setDescription("Ask Capy to work on a coding task")
  .addStringOption((option) => option.setName("task").setDescription("The coding task").setRequired(true));

export const modelCommand = new SlashCommandBuilder()
  .setName("capy-model")
  .setDescription("Set the default Capy model for this server")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((option) => option.setName("model").setDescription("Full provider/model ID"))
  .addStringOption((option) => option.setName("effort").setDescription("Reasoning effort")
    .addChoices(...(["low", "medium", "high", "xhigh"] as const).map((name) => ({ name, value: name }))));
