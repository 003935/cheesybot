import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageFlags, PermissionFlagsBits, type ButtonInteraction, type Client, type ThreadChannel } from "discord.js";
import type { CapyClient } from "../src/capy/client";
import { Conversations } from "../src/conversations";
import { createGitHubClient } from "../src/github/client";
import { stores } from "../src/state";
import type { config } from "../src/config";

const url = "https://github.com/acme/widget/pull/12";
const settings = { threadUrl: "https://capy.example/threads/{id}" } as typeof config;

function setup(request: (url: string, init?: RequestInit) => Promise<Response> = async () => Response.json({}), token = true) {
  const path = mkdtempSync(join(tmpdir(), "pr-actions-"));
  const state = stores(path);
  state.threads.data.thread = { capyThreadId: "jam", guildId: "guild", muted: false, archived: false, postedPrs: [url] };
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = async (target: string, init?: RequestInit) => {
    calls.push({ url: String(target), init });
    return request(target, init);
  };
  const service = new Conversations({} as Client, {} as CapyClient, state, settings,
    token ? createGitHubClient("secret", fetcher) : undefined);
  const interaction = (action: "approve" | "merge", admin = true, cardUrl = url) => {
    const replies: unknown[] = [];
    const fake = { customId: `pr:${action}:12`, guildId: "guild", channelId: "thread", user: { id: "member-1" },
      message: { content: `PR #12: ${cardUrl}`, embeds: [] },
      memberPermissions: { has: (permission: bigint) => admin && permission === PermissionFlagsBits.ManageGuild },
      reply: async (value: unknown) => { replies.push(value); }, deferReply: async (value: unknown) => { replies.push(value); },
      editReply: async (value: unknown) => { replies.push(value); } } as unknown as ButtonInteraction;
    return { fake, replies };
  };
  return { service, interaction, calls, state, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

test("PR cards include both actions and retain link buttons", async () => {
  const local = setup();
  try {
    local.state.threads.data.thread!.postedPrs = [];
    const sent: Record<string, unknown>[] = [];
    const channel = { send: async (value: Record<string, unknown>) => { sent.push(value); return {}; } } as unknown as ThreadChannel;
    await (local.service as unknown as { postPrs: (channel: ThreadChannel, link: unknown, items: unknown[]) => Promise<void> })
      .postPrs(channel, local.state.threads.data.thread, [{ source: "assistant", text: url }]);
    const card = sent[0]!;
    const buttons = (card.components as { components: { data: { label: string; custom_id?: string } }[] }[])[0]!.components;
    expect(buttons.map((button) => button.data.label)).toEqual(["View on GitHub", "Approve", "Merge", "Open in Capy"]);
    expect(buttons[1]!.data.custom_id).toBe("pr:approve:12");
    expect(buttons[2]!.data.custom_id).toBe("pr:merge:12");
    expect(card.allowedMentions).toEqual({ parse: [] });
    expect(card.content).toBe(`PR #12: ${url}\nCapy review: Unavailable (GitHub request failed)`);
    expect(card).not.toHaveProperty("embeds");
    expect(card.flags).toBe(MessageFlags.SuppressEmbeds);
  } finally { local.cleanup(); }
});

test("Capy status reads every review page and only counts the current head", async () => {
  let head = "new";
  let dismissed = false;
  const ref = { owner: "acme", repo: "widget", number: 12 };
  const github = createGitHubClient("secret", async (target) => {
    if (target.endsWith("/pulls/12")) return Response.json({ head: { sha: head } });
    const page = new URL(target).searchParams.get("page");
    return Response.json(page === "1" ? Array.from({ length: 100 }, () =>
      ({ user: { login: "capy-ai[bot]" }, commit_id: "old", state: "COMMENTED" })) :
      [{ user: { login: "other" }, commit_id: head, state: "APPROVED" },
        { user: { login: "capy-ai[bot]" }, commit_id: "new", state: dismissed ? "DISMISSED" : "COMMENTED" }]);
  });
  expect(await github.capyReview(ref)).toBe("Complete");
  dismissed = true;
  expect(await github.capyReview(ref)).toBe("Not yet reviewed on this head");
  head = "latest";
  expect(await github.capyReview(ref)).toBe("Not yet reviewed on this head");
});

test("PR cards refresh review status and preserve action validation", async () => {
  let reviewed = false;
  const local = setup(async (target) => target.endsWith("/pulls/12") ?
    Response.json({ state: "open", head: { sha: "abc" } }) :
    Response.json(reviewed ? [{ user: { login: "capy-ai[bot]" }, commit_id: "abc", state: "COMMENTED" }] : []));
  try {
    local.state.threads.data.thread!.postedPrs = [];
    const sent: Record<string, unknown>[] = [];
    const edits: Record<string, unknown>[] = [];
    const channel = { isThread: () => true,
      send: async (value: Record<string, unknown>) => { sent.push(value); return { id: "card" }; },
      messages: { fetch: async (id: string) => { expect(id).toBe("card"); return { edit: async (value: Record<string, unknown>) => { edits.push(value); } }; } } } as unknown as ThreadChannel;
    await (local.service as unknown as { postPrs: (channel: ThreadChannel, link: unknown, items: unknown[]) => Promise<void> })
      .postPrs(channel, local.state.threads.data.thread, [{ source: "assistant", text: url }]);
    expect(sent[0]?.content).toBe(`PR #12: ${url}\nCapy review: Not yet reviewed on this head`);
    expect(local.state.threads.data.thread!.prCards?.[url]?.messageId).toBe("card");
    Object.assign((local.service as unknown as { discord: object }).discord, { channels: { fetch: async () => channel } });
    reviewed = true;
    await local.service.refreshPrCards();
    await local.service.refreshPrCards();
    expect(edits).toHaveLength(1);
    expect(edits[0]?.content).toBe(`PR #12: ${url}\nCapy review: Complete`);
    const action = local.interaction("approve", false);
    (action.fake.message as { content: string }).content = String(edits[0]?.content);
    await local.service.prAction(action.fake);
    expect(action.replies[0]).toMatchObject({ content: "<@member-1> hey, don't do that. Manage Server permission is required." });
    const forged = local.interaction("merge", true, "https://github.com/other/repo/pull/12");
    (forged.fake.message as { content: string }).content += "\nCapy review: Complete";
    await local.service.prAction(forged.fake);
    expect(forged.replies[0]).toMatchObject({ content: "This PR card is not linked to an active conversation." });
  } finally { local.cleanup(); }
});

test("PR status does not query GitHub without a token", async () => {
  const local = setup(undefined, false);
  try {
    local.state.threads.data.thread!.postedPrs = [];
    const sent: Record<string, unknown>[] = [];
    await (local.service as unknown as { postPrs: (channel: ThreadChannel, link: unknown, items: unknown[]) => Promise<void> })
      .postPrs({ send: async (value: Record<string, unknown>) => { sent.push(value); return { id: "card" }; } } as ThreadChannel,
        local.state.threads.data.thread, [{ source: "assistant", text: url }]);
    await local.service.refreshPrCards();
    expect(sent[0]?.content).toBe(`PR #12: ${url}\nCapy review: Unavailable (configure GITHUB_TOKEN)`);
    expect(local.calls).toHaveLength(0);
  } finally { local.cleanup(); }
});

test("both PR buttons deny non-admins publicly without pinging or calling GitHub", async () => {
  const local = setup();
  try {
    for (const action of ["approve", "merge"] as const) {
      const denied = local.interaction(action, false);
      await local.service.prAction(denied.fake);
      expect(denied.replies).toEqual([{ content: "<@member-1> hey, don't do that. Manage Server permission is required.",
        allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds }]);
    }
    expect(local.calls).toHaveLength(0);
  } finally { local.cleanup(); }
});

test("forged card, archived link, and missing token never call GitHub", async () => {
  const local = setup();
  try {
    const forged = local.interaction("merge", true, "https://github.com/other/repo/pull/12");
    await local.service.prAction(forged.fake);
    expect(forged.replies).toEqual([{ content: "This PR card is not linked to an active conversation.",
      allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds }]);
    local.state.threads.data.thread!.archived = true;
    await local.service.prAction(local.interaction("approve").fake);
    expect(local.calls).toHaveLength(0);
  } finally { local.cleanup(); }
  const withoutToken = setup(undefined, false);
  try {
    const action = withoutToken.interaction("approve");
    await withoutToken.service.prAction(action.fake);
    expect(action.replies).toEqual([{ content: "PR actions are unavailable: configure GITHUB_TOKEN.",
      allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds }]);
    expect(withoutToken.calls).toHaveLength(0);
  } finally { withoutToken.cleanup(); }
});

test("previously posted embed cards still validate their PR URL", async () => {
  const local = setup(undefined, false);
  try {
    const action = local.interaction("approve");
    (action.fake.message as unknown as { content: string; embeds: { url: string }[] }).content = "";
    (action.fake.message as unknown as { embeds: { url: string }[] }).embeds = [{ url }];
    await local.service.prAction(action.fake);
    expect(action.replies[0]).toMatchObject({ content: "PR actions are unavailable: configure GITHUB_TOKEN." });
  } finally { local.cleanup(); }
});

test("approve submits review at current head, but refuses a closed PR", async () => {
  let state = "open";
  const local = setup(async (_url, init) => Response.json(init?.method === "POST" ? {} : { state, head: { sha: "abc" } }));
  try {
    const approved = local.interaction("approve");
    await local.service.prAction(approved.fake);
    expect(approved.replies[0]).toBeUndefined();
    expect(local.calls.map((call) => call.init?.method)).toEqual(["GET", "POST"]);
    expect(JSON.parse(String(local.calls[1]!.init?.body))).toEqual({ event: "APPROVE", commit_id: "abc" });
    expect(approved.replies.at(-1)).toMatchObject({ content: "Approved PR #12." });
    expect(approved.replies.at(-1)).toMatchObject({ flags: MessageFlags.SuppressEmbeds });
    expect(approved.replies.at(-1)).not.toHaveProperty("ephemeral");
    state = "closed";
    const closed = local.interaction("approve");
    await local.service.prAction(closed.fake);
    expect(closed.replies.at(-1)).toMatchObject({ content: "Refused: the PR is not open." });
    expect(local.calls).toHaveLength(3);
  } finally { local.cleanup(); }
});

test("merge refuses unmergeable, failed checks and failed statuses", async () => {
  let state = "open";
  let mergeable: boolean | null = null;
  let conclusion = "success";
  let status = "success";
  const local = setup(async (url) => {
    const path = String(url);
    if (path.endsWith("/pulls/12")) return Response.json({ state, mergeable, head: { sha: "abc" } });
    if (path.includes("check-runs")) return Response.json({ total_count: 1, check_runs: [{ status: "completed", conclusion }] });
    return Response.json({ state: status, statuses: [{ state: status }] });
  });
  try {
    state = "closed";
    const closed = local.interaction("merge");
    await local.service.prAction(closed.fake);
    expect(closed.replies.at(-1)).toMatchObject({ content: "Refused: the PR is not open." });
    state = "open";
    const unknown = local.interaction("merge");
    await local.service.prAction(unknown.fake);
    expect(unknown.replies.at(-1)).toMatchObject({ content: "Refused: the PR is not confirmed mergeable." });
    mergeable = true;
    conclusion = "failure";
    const checks = local.interaction("merge");
    await local.service.prAction(checks.fake);
    expect(checks.replies.at(-1)).toMatchObject({ content: "Refused: A check run failed or needs attention." });
    conclusion = "success";
    status = "error";
    const statuses = local.interaction("merge");
    await local.service.prAction(statuses.fake);
    expect(statuses.replies.at(-1)).toMatchObject({ content: "Refused: A commit status failed." });
    expect(local.calls.some((call) => call.init?.method === "PUT")).toBe(false);
  } finally { local.cleanup(); }
});

test("merge fails closed when GitHub cannot return complete check results", async () => {
  const local = setup(async (url) => String(url).endsWith("/pulls/12") ?
    Response.json({ state: "open", mergeable: true, head: { sha: "abc" } }) :
    Response.json({ total_count: 2, check_runs: [] }));
  try {
    const action = local.interaction("merge");
    await local.service.prAction(action.fake);
    expect(action.replies.at(-1)).toMatchObject({ content: "GitHub refused the action or could not verify the PR. Check its permissions, checks, and current state on GitHub." });
    expect(local.calls.some((call) => call.init?.method === "PUT")).toBe(false);
  } finally { local.cleanup(); }
});

test("merge inspects later check pages and pins successful merge to checked SHA", async () => {
  let secondPageFailure = true;
  const local = setup(async (url, init) => {
    const path = String(url);
    if (path.endsWith("/pulls/12")) return Response.json({ state: "open", mergeable: true, head: { sha: "abc" } });
    if (path.includes("check-runs")) return Response.json(new URL(path).searchParams.get("page") === "1" ?
      { total_count: 101, check_runs: Array.from({ length: 100 }, () => ({ status: "completed", conclusion: "success" })) } :
      { total_count: 101, check_runs: [{ status: "completed", conclusion: secondPageFailure ? "timed_out" : "success" }] });
    if (path.endsWith("/status")) return Response.json({ state: "success", statuses: [] });
    if (init?.method === "PUT") return Response.json({ merged: true });
    return Response.json({});
  });
  try {
    const failed = local.interaction("merge");
    await local.service.prAction(failed.fake);
    expect(failed.replies.at(-1)).toMatchObject({ content: "Refused: A check run failed or needs attention." });
    secondPageFailure = false;
    const succeeded = local.interaction("merge");
    await local.service.prAction(succeeded.fake);
    expect(succeeded.replies[0]).toBeUndefined();
    expect(succeeded.replies.at(-1)).toMatchObject({ content: "Merged PR #12." });
    expect(succeeded.replies.at(-1)).not.toHaveProperty("ephemeral");
    expect(JSON.parse(String(local.calls.find((call) => call.init?.method === "PUT")?.init?.body))).toEqual({ sha: "abc" });
  } finally { local.cleanup(); }
});
