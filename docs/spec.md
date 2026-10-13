# cheesybot spec

A Discord bot that sends coding tasks to Capy (https://capy.ai) through Capy's public API and posts the result (usually a pull request) back to Discord.

## Goals

- **v1, `/capy` command:** a member runs `/capy task:<text>`. The bot starts a Capy thread, waits for the run to end, and posts one result message.
- **v1.2, conversations like Capy for Slack:** `@cheesybot <task>` opens a Discord thread with live progress. Anyone can reply in the thread to steer the agent. `stop`/`mute`/`archive` controls, `model=`/`reasoning=` directives, `/capy-model` server defaults, and PR embeds with buttons.
- **v1.5, `/capy-notify` PR feed:** an admin picks a channel. Every PR Capy opens in the project gets posted there, including runs started from the Capy web app, Slack or Linear.
- **Later, not in scope now:** approve & merge from Discord (maintainers only), live-updating PR cards, channel→project mapping, forum-post triage (#bug-reports), and a Teams adapter.

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

## v1.2: conversations in Discord threads (mirrors Capy's Slack integration)

Model this on Capy's Slack integration (https://docs.capy.ai/integrations/slack.md): a task starts from a mention, lives in a thread, and the whole team talks to the agent in that thread.

### Starting a task

- **Mention:** a message in a server text channel that mentions the bot (`@cheesybot fix the login bug`) starts a task. Strip the mention from the text. Ignore messages from bots, and ignore mentions inside a thread that is already linked (those are replies; see below).
- **Slash:** `/capy task:<text>` keeps working and does the same thing.
- Starting a task:
  1. Parse directives out of the text (see Directives) and create the Capy thread with `requestId` = the Discord message ID (or the interaction ID for `/capy`).
  2. Create a Discord thread on the triggering message (for `/capy`, on the bot's reply), named from the first ~80 chars of the task.
  3. Store the link (see State) and start the watcher.
- Message text sent to Capy is prefixed with who wrote it: `[Discord · <display name>]: <text>`. Capy can't link Discord users to Capy accounts, so all threads are owned by the service user; the prefix is how the agent knows who said what.
- Needs the `GuildMessages` and `MessageContent` gateway intents. The README must tell the installer to enable **Message Content Intent** in the developer portal.
- DMs are out of scope.

### Replies in a linked thread

- Any non-bot message in a linked Discord thread is forwarded with `POST /threads/{id}/message`:
  - `text` with the same `[Discord · name]:` prefix.
  - `clientKey` = the Discord message ID, so a retried send is deduped.
  - `delivery: "steer"` while a run is in progress, otherwise the default.
- React 👀 to a forwarded message once Capy accepts it (`AdmitReceipt`). If the send fails, react ⚠️ and reply with a short error.
- If no watcher is running for that thread, start one.
- **Muted** threads forward only messages that mention the bot.
- Attachments are out of scope for v1.2; mention in the forwarded text that an attachment was skipped.

### Thread controls

Recognized when the whole message (ignoring a leading bot mention, case-insensitive) is one of:

| Word | Effect |
|---|---|
| `aside …` (prefix) | Not forwarded. Lets people talk without the agent seeing it. |
| `stop` | `POST /threads/{id}/interrupt`. Reply `⏹️ Stopped`. The thread stays linked. |
| `mute` / `unmute` | Toggle muted. Reply `🔇 Muted: mention me to talk to Capy` / `🔊 Unmuted`. |
| `archive` | `POST /threads/{id}/archive`, mark the link archived, then archive and lock the Discord thread. Later messages are ignored. |

### Directives

Parsed from the task text and from replies, then removed before sending:
- `model=<model id>`: per-message model. Sent as `model: { modelId }` on create or send. Full IDs only (no endpoint lists models, so no fuzzy matching).
- `reasoning=<none|instant|minimal|low|medium|high|xhigh|max>`: sent as `model.reasoningMode`, together with the effective model ID.
- Precedence: directive > guild setting from `/capy-model` > `CAPY_MODEL`.
- An unknown directive value gets a short error reply and nothing is sent.

### Live progress (inside the Discord thread)

- Each run gets one **status message** at the bottom of the Discord thread, posted when the watcher starts and edited while it runs:
  ```
  🦫 Working · 1m 12s · [Open in Capy](<link>)
  › <last 5 step lines>
  ```
  - Step lines are the `text` of `transcript` events with `source: "tool"`, plus the first line of `source: "assistant"` texts, each truncated to 120 chars.
  - Edit **at most once every 3 seconds** (throttle and coalesce; always flush the latest state). Never edit when nothing changed.
  - `waitForRunEnd` takes an `onEvent(frame)` callback, so `src/capy/` still knows nothing about Discord.
- When the run ends:
  - Edit the status message to `✅ Done · <elapsed>`, `❌ Failed` or `⏹️ Stopped`, keeping the step lines.
  - Post the agent's **final assistant message** for this run as a normal message: the reply in the conversation, up to 1900 chars plus `… [Open in Capy](<link>)` if truncated.
  - For each PR URL in this run's assistant messages that hasn't been posted in this thread before, post a **PR embed**:
    - title `PR #N`, url = PR link.
    - Two link buttons: **View on GitHub** and **Open in Capy**.
- All bot messages use `allowedMentions: { parse: [] }`.

### Watcher rules

- At most one watcher per Capy thread; starting one while one is running is a no-op.
- `?until=run` closes immediately when the thread isn't working yet. After `done`, fetch the thread. If its status is still `working`, watch again, for up to 3 extra rounds.
- Resume from the stored `lastTranscriptId` with `?after=`.

### State

`data/threads.json`, keyed by Discord thread ID:
```json
{ "capyThreadId": "jam_…", "guildId": "…", "muted": false, "archived": false,
  "postedPrs": ["https://github.com/…/pull/3"], "lastTranscriptId": "01M…" }
```
- Write it atomically (write a temp file, then rename).
- On startup, for each linked, non-archived thread, fetch the Capy thread. If it's `working`, start a watcher. That way a restart mid-run still reports the result.

### `/capy-model [model] [effort]`

- Requires Manage Server permission.
- With no options, it replies (ephemeral) with the current model and effort for this server.
- `model`: free-text model ID. `effort`: a choice of `low | medium | high | xhigh`, mapped to `model.reasoningMode`.
- Stored per guild in `data/settings.json`.

### Model errors

When creating a thread or sending a message returns `ModelSelection.Rejected`:
- `rejection: "not_connected"` or `"disconnected"`: `🔌 This model needs a connected <service> subscription: [Connect in Capy](<https://capy.ai/settings/integrations>)`
- `message` starting with `Unknown model`: `Unknown model <id>. Use model=<id> or ask an admin to run /capy-model.`

### Observed stream payloads

Captured from a real run in `test/fixtures/stream-ping.sse`. These shapes are observed, not documented, so parse them defensively: skip anything that doesn't match and never throw on unknown fields.

- `status`: `{"threadId","status":"working"|"idle"|...}`
- `transcript` (with an `id:` line): a transcript message, e.g.
  - `{"id","source":"tool","tool":"bash","text":"Inspecting repository instructions and command layout","createdAt"}`
  - `{"id","source":"assistant","text":"...","model":"openai/gpt-6-sol","callId","createdAt"}`
  - `{"id","source":"user","text":"...","authorName","createdAt"}`
- `assistant`: token fragments `{"callId","text":"PR"}`. **Ignore these**; the finished text arrives later as a `transcript` event.
- `turn`: `{"phase":"start"}` / `{"phase":"end","outcome":"settled"}`
- `run`: `{"phase":"end"}`

### Out of scope for v1.2

`!new` / `!web` forks, `project=` and channel→project mapping, live-updating PR cards (checks, diff totals, merge notices), attachments, DMs.

## v1.3: access control

- By default, only guild members with Manage Server can start tasks or affect linked conversations. A guild may additionally allow one role; Manage Server always retains access.
- `/capy-access` requires Manage Server. `role:<role>` grants that role access, `reset:true` returns to Manage Server only, and no options shows the current policy. Reject using `role` and `reset` together. Responses are ephemeral.
- Store the optional role ID per guild in `data/settings.json` alongside model defaults. Changing model defaults must preserve the access role and changing access must preserve model defaults; settings survive restarts.
- Check access before creating a task from `/capy` or a bot mention, before forwarding any linked-thread reply (including directives), and before `stop`, `mute`, `unmute`, or `archive`. Unauthorized new tasks get an ephemeral slash response or a short mention reply explaining who can use Capy; unauthorized messages in linked threads are ignored silently.
- Register `/capy-access`, document the policy in the README, and test admin, role, unauthorized, reset, and persistence paths with fake Discord objects.

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
