# cheesybot

A Discord bot that sends coding tasks to [Capy](https://capy.ai) and posts the resulting pull requests back to Discord.

- `/capy task:<text>` opens a Discord thread, streams the agent's progress into it, and posts the PR link when the run ends.
- Replies in the thread are forwarded to the Capy thread as follow-ups.

Status: work in progress.

## Setup

1. `cp .env.example .env` and fill in the values. Use a Capy **service user** key.
2. `bun install`
3. `bun start`

## License

MIT
