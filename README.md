# cheesybot

A Discord bot that sends coding tasks to [Capy](https://capy.ai) and posts the resulting pull requests back to Discord.

- `/capy task:<text>` starts a Capy run and replies to the command message with its result or PR link when the run ends.
- `/ping` replies with `pong 🐱` and the bot's Discord heartbeat latency in milliseconds.

The v1 bot does not forward replies or provide a PR notification feed.

## Setup

1. Install Bun 1.3.x, then run `bun install --frozen-lockfile`.
2. Copy `.env.example` to `.env`. Set `DISCORD_TOKEN` and `DISCORD_CLIENT_ID` from the Discord Developer Portal; set `CAPY_API_KEY` to a Capy **service user** key and `CAPY_PROJECT_ID` to the target project. Optionally set `CAPY_THREAD_URL` to your Capy thread link format with `{id}` as the placeholder. Never commit `.env`.
3. Invite the bot to your server using `https://discord.com/oauth2/authorize?client_id=<DISCORD_CLIENT_ID>&scope=bot%20applications.commands&permissions=134286336` (View Channel, Send Messages, Send Messages in Threads, and Read Message History). Replace the client ID placeholder. The bot also needs access to the channel where `/capy` is invoked.
4. Run `bun run register` to register the global `/capy` and `/ping` slash commands, then `bun start`. Global command propagation may take time.

Run `bun run check` and `bun test` before pushing. Tests use fake HTTP responses and need no Discord or Capy credentials.

## License

MIT
