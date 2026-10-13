import type { Model, Reasoning } from "./capy/client";

const efforts: Reasoning[] = ["none", "instant", "minimal", "low", "medium", "high", "xhigh", "max"];
export type ModelDefault = { modelId?: string; reasoningMode?: Reasoning };

export function parseDirectives(text: string, guild: ModelDefault = {}, fallback?: string): { text: string; model?: Model } {
  let modelId: string | undefined;
  let reasoningMode: Reasoning | undefined;
  const cleaned = text.replace(/(?:^|\s)(model|reasoning)=([^\s]*)/gi, (_match, key: string, value: string) => {
    if (key.toLowerCase() === "model") {
      if (!/^[\w.-]+\/[\w.-]+$/.test(value)) throw new Error("Use a full model ID such as provider/model.");
      modelId = value;
    } else {
      if (!efforts.includes(value as Reasoning)) throw new Error(`Unknown reasoning effort: ${value}`);
      reasoningMode = value as Reasoning;
    }
    return "";
  }).trim().replace(/\s{2,}/g, " ");
  const effective = modelId ?? guild.modelId ?? fallback;
  if (effective && !/^[\w.-]+\/[\w.-]+$/.test(effective)) throw new Error("Use a full model ID such as provider/model.");
  const effort = reasoningMode ?? guild.reasoningMode;
  if (effort && !effective) throw new Error("Set a model before choosing reasoning effort.");
  return { text: cleaned, ...(effective ? { model: { modelId: effective, ...(effort ? { reasoningMode: effort } : {}) } } : {}) };
}

export function modelError(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("tag" in error) || error.tag !== "ModelSelection.Rejected") return;
  const detail = "detail" in error ? error.detail as { rejection?: string; service?: string; message?: string; modelId?: string } : undefined;
  if (detail?.rejection === "not_connected" || detail?.rejection === "disconnected") {
    const service = detail.service ?? "provider";
    return `🔌 This model needs a connected ${service} subscription: [Connect in Capy](<https://capy.ai/settings/integrations>)`;
  }
  if (detail?.message?.startsWith("Unknown model")) {
    const id = detail.modelId ?? detail.message.match(/^Unknown model:?\s+(\S+)/)?.[1] ?? "ID";
    return `Unknown model ${id}. Use model=<id> or ask an admin to run /capy-model.`;
  }
}
