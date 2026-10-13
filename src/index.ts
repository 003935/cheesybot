import { Client, Events, GatewayIntentBits } from "discord.js";
import { createCapyClient } from "./capy/client";
import { handleCapy } from "./commands/capy";
import { handlePing } from "./commands/ping";
import { config } from "./config";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const capy = createCapyClient(config.capyApiKey, config.capyBaseUrl);

client.on(Events.InteractionCreate, (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "ping") {
    void handlePing(interaction).catch((error: unknown) => console.error("Ping command failed", error));
  } else if (interaction.commandName === "capy") {
    void handleCapy(interaction, capy, config).catch((error: unknown) => console.error("Capy command failed", error));
  }
});

client.once(Events.ClientReady, (ready) => console.log(`Ready as ${ready.user.tag}`));
await client.login(config.discordToken);
