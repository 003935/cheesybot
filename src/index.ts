import { Client, Events, GatewayIntentBits } from "discord.js";
import { createCapyClient } from "./capy/client";
import { handlePing } from "./commands/ping";
import { Conversations } from "./conversations";
import { config } from "./config";
import { stores } from "./state";
import { createGitHubClient } from "./github/client";

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const conversations = new Conversations(client, createCapyClient(config.capyApiKey, config.capyBaseUrl), stores(), config,
  config.githubToken ? createGitHubClient(config.githubToken) : undefined);

client.on(Events.InteractionCreate, (interaction) => {
  if (interaction.isButton()) {
    void conversations.prAction(interaction).catch((error: unknown) => console.error("PR interaction failed", error));
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "ping") {
    void handlePing(interaction).catch((error: unknown) => console.error("Ping command failed", error));
    return;
  }
  const action = interaction.commandName === "capy" ? conversations.slash(interaction) :
    interaction.commandName === "capy-model" ? conversations.modelSetting(interaction) :
    interaction.commandName === "capy-access" ? conversations.accessSetting(interaction) : undefined;
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
