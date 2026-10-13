# cheesybot spec

A Discord bot that sends coding tasks to Capy (https://capy.ai) through Capy's public API and posts the result (usually a pull request) back to Discord.

## Goals

- **v1, `/capy` command:** a member runs `/capy task:<text>`. The bot starts a Capy thread, waits for the run to end, and posts one result message.
- **v1.5, `/capy-notify` PR feed:** an admin picks a channel. Every PR Capy opens in the project gets posted there, including runs started from the Capy web app, Slack or Linear.
- **Later, not in scope now:** live progress edits in a Discord thread, forwarding Discord replies to Capy, Stop/Ask-for-changes buttons, SQLite persistence and resume after restart, forum-post triage (#bug-reports), and a Teams adapter.

## Stack

- Bun + TypeScript + discord.js v14. Plain discord.js, no framework.
- `bun test` for tests.
- Config from `.env` (see `.env.example`): `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `CAPY_API_KEY`, `CAPY_PROJECT_ID`, and optionally `CAPY_BASE_URL` (default `https://api.capy.ai/api/v1`) and `CAPY_THREAD_URL` (web link template containing `{id}`).

## Architecture

```
src/
  index.ts            discord.js client, registers slash commands, routes interactions
  config.ts           read + validate env; throw with a clear message if anything is missing
  capy/client.ts      the ONLY module that talks HTTP to Capy
  capy/sse.ts         parse a text/event-stream body into { event, id?, data } frames
  capy/watch.ts       waitForRunEnd(): stream until the run ends, reconnecting on drops
  result.ts           pure: (thread, transcript) -> Result
  commands/capy.ts    /capy handler: wires the pieces together
  commands/notify.ts  /capy-notify handler (v1.5)
  notify/poller.ts    PR feed poller (v1.5)
```

Boundary rule: nothing under `src/capy/` imports discord.js, and nothing outside `src/capy/` calls `fetch`. `client.ts` takes `fetch` as an injectable dependency so tests can fake it.

## Capy API facts (verified against https://docs.capy.ai/openapi.json)

Read the OpenAPI spec before writing the client. Don't guess paths or fields.

- Auth: `Authorization: Bearer <CAPY_API_KEY>`. The key belongs to a service user.
- **Create thread:** `POST /threads` with body `{ requestId, projectId, message, title?, pullRequestAuthor? }`, which returns a `Thread`.
  - `requestId` (1–191 chars) is an idempotency key. Always use the Discord interaction ID, so a retried interaction never starts a second billed run.
  - Send `pullRequestAuthor: "capy"` so PRs are opened by the Capy GitHub App.
  - Leave `visibility` unset; `private` requires `authorId` for service keys.
- **Get thread:** `GET /threads/{id}`. `status` is one of `working | waiting | idle | failed | archived`. (Some docs pages list other statuses; the OpenAPI enum above is authoritative.)
- **List threads:** `GET /threads?projectId=&limit=&cursor=` returns `{ items: Thread[], cursor }`.
- **Transcript:** `GET /threads/{id}/messages?after=&limit=` returns `{ items, cursor, beforeCursor }`.
  - Each item is `{ id, source: "user"|"assistant"|"tool", text, createdAt, ... }`.
  - With no `after` you get the **oldest** page. To reach the newest messages, page forward with `after=cursor` until `cursor` is null.
  - If `cursor` stops changing, unsettled messages are blocking; retry shortly.
- **Stream:** `GET /threads/{id}/stream?until=run` (SSE). Resume with the `Last-Event-ID` header or `?after=<last transcript id>`.
  - Event names: `status`, `transcript` (carries an `id:` line), `run`, `turn`, `assistant`, `tool_call`, `subagent`, `task`, `heartbeat` (~15s), `error`, `done`.
  - **Frame `data` payloads are untyped in the OpenAPI spec** (just "JSON string"). v1 must depend only on event names, `id:` lines and `done`/`error`, and must not depend on payload fields. Log unknown payloads at debug level.
  - A close without `done` or `error` is a drop: reconnect after about 2s.
- **Errors:** JSON with a `_tag`, for example `capy/Unauthorized`, `capy/Forbidden`, `capy/ProjectNotFound`, `capy/ThreadNotFound`, `capy/PaidFeatureUnavailable` (402), `capy/RateLimited` (429, carries `retryAfterSeconds`), `capy/StreamUnavailable` (503), `capy/InvalidRequest`. Map them to a typed `CapyError { tag, status, retryAfterSeconds? }`.
- **No PR field exists.** The PR link appears only in assistant message text. Extract it with `/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g`; when there are several, the last match wins.
- **No outbound webhooks** for thread events, so v1.5 has to poll.

## v1: `/capy task:<text>`

1. `interaction.deferReply()` right away (Discord allows 3s and creating a thread can take longer).
2. `createThread({ requestId: interaction.id, projectId, message: task, title: first ~80 chars of task, pullRequestAuthor: "capy" })`.
3. Edit the deferred reply to say `🦫 On it: <capy link>`. The API has no thread web-URL field. A "capy link" means `CAPY_THREAD_URL` with `{id}` replaced when that env var is set (e.g. `https://capy.ai/threads/{id}`); when it isn't set, show `Capy thread <id>` as plain text.
4. In the background (do not block the interaction handler), call `waitForRunEnd(threadId)`:
   - Open the stream with `?until=run`, skip `heartbeat`, and track the last `transcript` id.
   - Return on `done`. On `error`, or after a drop, reconnect after 2s with `?after=<last id>`. On a 429, wait `retryAfterSeconds`.
   - Give up after 5 consecutive failed reconnects and return `"lost"`.
5. Fetch the thread and the transcript, then compute the `Result` (in `result.ts`, a pure function):
   - `pr`: the last assistant message (or any assistant message from this run) contains a PR URL → `✅ PR ready: <url>`
   - `failed`: thread `status === "failed"` → `❌ Run failed: <capy link>`
   - `needs_input`: anything else → `🤔 Capy needs input: <last assistant text, truncated to 1500 chars> <capy link>`
   - If the watcher returned `lost`: `⚠️ Lost track of this run: <capy link>`
6. Post the result with `channel.send`, as a reply to the original interaction message. Don't edit the interaction, because interaction tokens expire after 15 minutes and runs can take longer.
7. Thread-creation errors: edit the deferred reply with a short message per `_tag`. Unauthorized/Forbidden become "bot is misconfigured", PaidFeatureUnavailable becomes "plan limit reached", RateLimited becomes "busy, try again in Ns".

## v1.5: `/capy-notify channel:<#channel>`

- Requires Manage Server permission. Stores `guildId → channelId` in a small JSON file (`data/notify.json`).
- The poller runs every 45s:
  - `GET /threads?projectId=` and keep threads whose `updatedAt` changed since the last poll.
  - For each one, read new transcript messages (page forward from the last seen cursor) and extract PR URLs.
  - Post any PR URL not seen before as an embed: PR link, Capy thread title, Capy link.
  - Keep a seen-URLs set in the same JSON file so restarts don't repost.
- On the first poll after startup, record existing PRs as seen without posting them, so the bot doesn't flood the channel.

## Testing

- `result.ts`: table tests for one PR URL, several URLs (last wins), no URL, a `failed` status, and empty text.
- `sse.ts`: parse multi-line `data:`, `id:` lines, comments, and a chunk boundary that splits a frame.
- `client.ts` + `watch.ts` with a fake `fetch`: a clean `done`, a drop then a resume that sends `?after=`, a 429 with `retryAfterSeconds`, a tagged error mapped to `CapyError`, and giving up after 5 failures.
- No test calls the real Capy or Discord APIs. Live testing happens manually with a real `.env`.

## Non-goals

- Cloning or reverse-engineering Capy. cheesybot uses only the documented public API.
- Multi-project support (v1 uses one `CAPY_PROJECT_ID`).
