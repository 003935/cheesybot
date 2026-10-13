import { REST, Routes } from "discord.js";
import { capyCommand } from "./commands/capy";
import { config } from "./config";

await new REST({ version: "10" }).setToken(config.discordToken).put(
  Routes.applicationCommands(config.discordClientId),
  { body: [capyCommand.toJSON()] },
);
console.log("Registered /capy command");
