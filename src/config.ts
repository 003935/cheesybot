function required(name: string): string {
  const value = Bun.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}; see .env.example`);
  return value;
}

const threadUrl = Bun.env.CAPY_THREAD_URL?.trim();
if (threadUrl && (!threadUrl.includes("{id}") || !threadUrl.startsWith("https://"))) {
  throw new Error("CAPY_THREAD_URL must be an HTTPS URL containing {id}");
}

export const config = {
  discordToken: required("DISCORD_TOKEN"),
  discordClientId: required("DISCORD_CLIENT_ID"),
  capyApiKey: required("CAPY_API_KEY"),
  capyProjectId: required("CAPY_PROJECT_ID"),
  capyBaseUrl: Bun.env.CAPY_BASE_URL?.trim() || "https://api.capy.ai/api/v1",
  capyModel: Bun.env.CAPY_MODEL?.trim() || undefined,
  threadUrl,
  githubToken: Bun.env.GITHUB_TOKEN?.trim() || undefined,
};
