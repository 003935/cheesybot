# cheesybot

A Discord bot that sends coding tasks to [Capy](https://capy.ai) and posts the resulting pull requests back to Discord.

- Mention `@cheesybot <task>` in a server text channel, or use `/capy task:<text>`, to open a Discord thread with live status and the final Capy reply. Everyone in that thread can send follow-ups to Capy.
- `/ping` replies with `pong 🐱` and the bot's Discord heartbeat latency in milliseconds.

Use `aside ...` for a teammate-only reply; `stop` interrupts a run; `mute` and `unmute` control whether ordinary replies reach Capy (mentions still do); `archive` closes and locks the conversation. Prefix controls with `@cheesybot` if desired. Attachments and DMs are not supported. The PR notification feed is not part of v1.2.

## Setup

1. Install Bun 1.3.x, then run `bun install --frozen-lockfile`.
2. Copy `.env.example` to `.env`. Set `DISCORD_TOKEN` and `DISCORD_CLIENT_ID` from the Discord Developer Portal; set `CAPY_API_KEY` to a Capy **service user** key and `CAPY_PROJECT_ID` to the target project. Optionally set `CAPY_MODEL` to a full model ID and `CAPY_THREAD_URL` to your Capy thread link format with `{id}` as the placeholder. Never commit `.env`. Set `CAPY_THREAD_URL` to enable the **Open in Capy** button on PR cards.
3. Enable **Message Content Intent** under the Discord application's Bot settings. Invite the bot with `https://discord.com/oauth2/authorize?client_id=<DISCORD_CLIENT_ID>&scope=bot%20applications.commands&permissions=51673893888` (View Channel, Send Messages, Read Message History, Send Messages in Threads, Create Public Threads, Manage Threads). Replace the client ID placeholder and grant access to the channels where you use it.
4. Run `bun run register` to register `/capy`, `/capy-model`, and `/ping`, then `bun start`. Global command propagation may take time. Keep `data/threads.json` and `data/settings.json` on persistent storage so restarts resume active threads.

Add `model=provider/model` or `reasoning=low|medium|high|xhigh` to a task or reply; directives are removed from the text sent to Capy. A Manage Server member can set the guild default with `/capy-model model:<full ID> effort:<level>`, or run it without options to see the current setting. A directive overrides the guild default, which overrides `CAPY_MODEL`.

Run `bun run check` and `bun test` before pushing. Tests use fake HTTP responses and need no Discord or Capy credentials.

## License

MIT
