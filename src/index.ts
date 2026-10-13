import { Client, Events, GatewayIntentBits } from "discord.js";
import { createCapyClient } from "./capy/client";
import { handleCapy } from "./commands/capy";
import { config } from "./config";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const capy = createCapyClient(config.capyApiKey, config.capyBaseUrl);

client.on(Events.InteractionCreate, (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "capy") return;
  void handleCapy(interaction, capy, config).catch((error: unknown) => {
    console.error("Capy command failed", error);
  });
});

client.once(Events.ClientReady, (ready) => console.log(`Ready as ${ready.user.tag}`));
await client.login(config.discordToken);
