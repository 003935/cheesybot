export type PullRequest = { state: string; mergeable: boolean | null; head: { sha: string } };
export type PrRef = { owner: string; repo: string; number: number };
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export function createGitHubClient(token: string, request: Fetch = fetch) {
  const endpoint = (ref: PrRef) => `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${ref.number}`;
  async function call<T>(url: string, method = "GET", body?: object): Promise<T> {
    const response = await request(url, { method, headers: {
      Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`GitHub request failed (${response.status}). Check token permissions and PR state.`);
    return response.json() as Promise<T>;
  }
  return {
    getPull: (ref: PrRef) => call<PullRequest>(endpoint(ref)),
    approve: (ref: PrRef, sha: string) => call(endpoint(ref) + "/reviews", "POST", { event: "APPROVE", commit_id: sha }),
    async merge(ref: PrRef, sha: string) {
      const result = await call<{ merged: boolean }>(endpoint(ref) + "/merge", "PUT", { sha });
      if (result.merged !== true) throw new Error("GitHub did not confirm the merge.");
    },
    async checkFailures(ref: PrRef, sha: string): Promise<string | undefined> {
      const base = `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/commits/${encodeURIComponent(sha)}`;
      let page = 1;
      let fetched = 0;
      while (true) {
        const runs = await call<{ total_count: number; check_runs: { status: string; conclusion: string | null }[] }>(
          `${base}/check-runs?per_page=100&page=${page++}`);
        if (!Array.isArray(runs.check_runs) || !Number.isInteger(runs.total_count)) throw new Error("GitHub check results are incomplete.");
        if (runs.check_runs.some((run) => run.status === "completed" && run.conclusion !== "success" && run.conclusion !== "neutral" && run.conclusion !== "skipped"))
          return "A check run failed or needs attention.";
        fetched += runs.check_runs.length;
        if (fetched >= runs.total_count) break;
        if (!runs.check_runs.length) throw new Error("GitHub check results are incomplete.");
      }
      const statuses = await call<{ state: string; statuses: { state: string }[] }>(`${base}/status`);
      if (!Array.isArray(statuses.statuses) || typeof statuses.state !== "string") throw new Error("GitHub commit statuses are incomplete.");
      if (statuses.state === "failure" || statuses.statuses.some((status) => status.state === "failure" || status.state === "error"))
        return "A commit status failed.";
      return undefined;
    },
  };
}

export type GitHubClient = ReturnType<typeof createGitHubClient>;
