import { REST, Routes } from "discord.js";
import { capyCommand } from "./commands/capy";
import { pingCommand } from "./commands/ping";
import { config } from "./config";

await new REST({ version: "10" }).setToken(config.discordToken).put(
  Routes.applicationCommands(config.discordClientId),
  { body: [capyCommand.toJSON(), pingCommand.toJSON()] },
);
console.log("Registered /capy and /ping commands");
