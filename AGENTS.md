# Instructions for coding agents

cheesybot is a Discord bot that sends coding tasks to Capy through Capy's public API. These rules apply to every change, however short the request is.

## Before you build

- Read `docs/spec.md`. For a new feature, add a section for it to the spec (behavior, permissions, errors, tests) and then implement that section.
- Read `https://docs.capy.ai/openapi.json` before touching Capy API calls, and GitHub's REST docs before touching GitHub calls. Don't guess endpoints or fields.
- Follow the patterns already in `src/` and `test/`.

## Boundaries

- Only `src/capy/` calls the Capy API. Only `src/github/` calls the GitHub API.
- Neither of those folders imports discord.js. Nothing outside them calls `fetch`.
- API clients take `fetch` as an injectable parameter so tests can fake it.

## Permissions and safety

- Anything that **spends money** (starts or continues a Capy run) must go through the existing `/capy-access` check.
- Anything that **writes to GitHub** (approve, merge, comment, close) requires **Manage Server**, even for members `/capy-access` allows.
- Merges must refuse unless the PR is open and mergeable and no check run or commit status has failed. Say why when refusing.
- Every gated action needs a test for the denied case, not just the allowed case.
- Bot messages use `allowedMentions: { parse: [] }`. Never echo secrets, tokens or env values into Discord or logs.
- New secrets go in `.env.example` with an empty value and a comment; read them in `src/config.ts`.

## Tests and done

- Tests use fake `fetch` and fake Discord objects. No test calls the real Capy, GitHub or Discord APIs.
- New slash commands are registered in `src/register.ts` and documented in `README.md`.
- Done means `bun test` and `bun run check` both pass. In the PR description, list anything from the spec you couldn't follow or had to guess.
