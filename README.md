# cheesybot

A Discord bot that sends coding tasks to [Capy](https://capy.ai) and posts the resulting pull requests back to Discord.

- Members with Manage Server can mention `@cheesybot <task>` in a server text channel or use `/capy task:<text>` to open a Discord thread with live status and the final Capy reply. They can also send follow-ups and use thread controls; a server may allow one additional role with `/capy-access`.
- `/ping` replies with `pong 🐱` and the bot's Discord heartbeat latency in milliseconds.
- A Manage Server member can set `/capy-notify channel:<#channel>` to post new project PRs from any Capy entry point. The bot checks every 45 seconds and skips existing PRs on first startup.

Use `aside ...` for a teammate-only reply; `stop` interrupts a run; `mute` and `unmute` control whether ordinary replies reach Capy (mentions still do); `archive` closes and locks the conversation. Prefix controls with `@cheesybot` if desired. Attachments and DMs are not supported.

PR cards keep the PR URL on the first line without embeds or link previews; **Approve** and **Merge** buttons remain available to members with Manage Server. Set `GITHUB_TOKEN` to a maintainer account's token with pull-request write access to enable the actions; that GitHub account submits reviews and merges, not the Discord clicker's identity. GitHub does not allow approving your own PR. Merge refuses closed or unmergeable PRs and failed checks or statuses; branch protection still applies.

PR cards also show whether Capy's GitHub review is complete on the current PR head. With `GITHUB_TOKEN`, the bot refreshes tracked cards every 45 seconds; without it, the card says the review status is unavailable. This reflects submitted GitHub reviews, not Capy's internal queued or running state.

## Setup

1. Install Bun 1.3.x, then run `bun install --frozen-lockfile`.
2. Copy `.env.example` to `.env`. Set `DISCORD_TOKEN` and `DISCORD_CLIENT_ID` from the Discord Developer Portal; set `CAPY_API_KEY` to a Capy **service user** key and `CAPY_PROJECT_ID` to the target project. Optionally set `CAPY_MODEL` to a full model ID, `CAPY_THREAD_URL` to your Capy thread link format with `{id}` as the placeholder, and `GITHUB_TOKEN` to a maintainer GitHub token for PR actions. Never commit `.env`. Set `CAPY_THREAD_URL` to enable the **Open in Capy** button on PR cards.
3. Enable **Message Content Intent** under the Discord application's Bot settings. Invite the bot with `https://discord.com/oauth2/authorize?client_id=<DISCORD_CLIENT_ID>&scope=bot%20applications.commands&permissions=51673893888` (View Channel, Send Messages, Read Message History, Send Messages in Threads, Create Public Threads, Manage Threads). Replace the client ID placeholder and grant access to the channels where you use it.
4. Run `bun run register` to register `/capy`, `/capy-model`, `/capy-access`, `/capy-notify`, and `/ping`, then `bun start`. Global command propagation may take time. Keep `data/threads.json`, `data/settings.json`, and `data/notify.json` on persistent storage so restarts resume active threads, access settings, and notification deduplication. Give the bot View Channel and Send Messages permissions in the chosen notification channel.

Add `model=provider/model` or `reasoning=low|medium|high|xhigh` to a task or reply; directives are removed from the text sent to Capy. A Manage Server member can set the guild default with `/capy-model model:<full ID> effort:<level>`, or run it without options to see the current setting. A directive overrides the guild default, which overrides `CAPY_MODEL`.

Only Manage Server members can use Capy by default. A Manage Server member can run `/capy-access role:<role>` to let members with that role start tasks, send linked-thread replies, and use `stop`, `mute`, `unmute`, and `archive`. Run `/capy-access` without options to see the current policy, or `/capy-access reset:true` to restore Manage Server-only access. Unauthorized replies in linked threads are silently ignored.

Run `bun run check` and `bun test` before pushing. Tests use fake HTTP responses and need no Discord or Capy credentials.

## License

MIT
