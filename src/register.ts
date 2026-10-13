import { REST, Routes } from "discord.js";
import { pingCommand } from "./commands/ping";
import { accessCommand, capyCommand, modelCommand } from "./commands/capy";
import { config } from "./config";

await new REST({ version: "10" }).setToken(config.discordToken).put(
  Routes.applicationCommands(config.discordClientId),
  { body: [capyCommand.toJSON(), modelCommand.toJSON(), accessCommand.toJSON(), pingCommand.toJSON()] },
);
console.log("Registered /capy, /capy-model, /capy-access, and /ping commands");
