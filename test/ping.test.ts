import { expect, test } from "bun:test";
import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { handlePing, pingCommand } from "../src/commands/ping";

test("/ping is a slash command without options", () => {
  expect(pingCommand.toJSON()).toMatchObject({ name: "ping", options: [] });
});

test("/ping replies with the bot's Discord heartbeat latency", async () => {
  let reply: unknown;
  const interaction = {
    client: { ws: { ping: 42.6 } },
    reply: async (content: unknown) => { reply = content; },
  } as unknown as ChatInputCommandInteraction;

  await handlePing(interaction);
  expect(reply).toEqual({ content: "pong 🐱 (43ms)", allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds });
});
