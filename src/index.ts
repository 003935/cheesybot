import { Client, Events, GatewayIntentBits } from "discord.js";
import { createCapyClient } from "./capy/client";
import { handlePing } from "./commands/ping";
import { Conversations } from "./conversations";
import { config } from "./config";
import { stores } from "./state";

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const conversations = new Conversations(client, createCapyClient(config.capyApiKey, config.capyBaseUrl), stores(), config);

client.on(Events.InteractionCreate, (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "ping") {
    void handlePing(interaction).catch((error: unknown) => console.error("Ping command failed", error));
    return;
  }
  const action = interaction.commandName === "capy" ? conversations.slash(interaction) :
    interaction.commandName === "capy-model" ? conversations.modelSetting(interaction) : undefined;
  void action?.catch((error: unknown) => console.error("Discord command failed", error));
});
client.on(Events.MessageCreate, (message) => {
  void conversations.mention(message).catch((error: unknown) => console.error("Discord message failed", error));
  if (message.channel.isThread() && !message.mentions.users.has(client.user!.id)) {
    void conversations.reply(message).catch((error: unknown) => console.error("Discord reply failed", error));
  }
});
client.once(Events.ClientReady, (ready) => {
  console.log(`Ready as ${ready.user.tag}`);
  void conversations.resume();
});
await client.login(config.discordToken);
