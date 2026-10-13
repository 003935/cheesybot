import { REST, Routes } from "discord.js";
import { pingCommand } from "./commands/ping";
import { accessCommand, capyCommand, modelCommand } from "./commands/capy";
import { config } from "./config";
import { notifyCommand } from "./commands/notify";

await new REST({ version: "10" }).setToken(config.discordToken).put(
  Routes.applicationCommands(config.discordClientId),
  { body: [capyCommand.toJSON(), modelCommand.toJSON(), accessCommand.toJSON(), notifyCommand.toJSON(), pingCommand.toJSON()] },
);
console.log("Registered /capy, /capy-model, /capy-access, /capy-notify, and /ping commands");
