/**
 * 내 LLM: a model of the operator's own choosing, run in OpenCode. Either a
 * server of their own (Ollama, LM Studio, vLLM -- anything that serves the
 * OpenAI API) or an API platform reached with a key from 내 API 키
 * (main/llm-keys.ts). OpenCode does the files and commands, the model does the
 * thinking. Told through a settings file of Lepons' own (OPENCODE_CONFIG) and
 * `-m`, so the operator's own OpenCode settings are never touched.
 */

/** The API platforms a key can be for: OpenCode's own provider ids, so it calls each the way that platform expects. */
export const LLM_PLATFORMS = {
  openrouter: { label: "OpenRouter", models: "https://openrouter.ai/api/v1/models", auth: "bearer", keys: "https://openrouter.ai/settings/keys" },
  openai: { label: "OpenAI", models: "https://api.openai.com/v1/models", auth: "bearer", keys: "https://platform.openai.com/api-keys" },
  anthropic: { label: "Anthropic", models: "https://api.anthropic.com/v1/models?limit=1000", auth: "anthropic", keys: "https://console.anthropic.com/settings/keys" },
  google: { label: "Google Gemini", models: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", auth: "google", keys: "https://aistudio.google.com/apikey" },
  deepseek: { label: "DeepSeek", models: "https://api.deepseek.com/models", auth: "bearer", keys: "https://platform.deepseek.com/api_keys" },
  groq: { label: "Groq", models: "https://api.groq.com/openai/v1/models", auth: "bearer", keys: "https://console.groq.com/keys" },
} as const;

export type LlmPlatform = keyof typeof LLM_PLATFORMS;

export const isLlmPlatform = (value: unknown): value is LlmPlatform => typeof value === "string" && Object.hasOwn(LLM_PLATFORMS, value);

export interface LocalLlm {
  id: string;
  /** What the picker shows: "GPU PC · Qwen Coder". */
  name: string;
  /** Where the model is: an API platform, or absent for a server of one's own. */
  platform?: LlmPlatform;
  /** A server of one's own: its OpenAI root, ending in /v1 (http://192.168.0.5:11434/v1). "" for a platform. */
  baseUrl: string;
  model: string;
  /**
   * Reached through an SSH tunnel to this registered PC instead of the
   * network: the server listens on that PC's own port. A session on another
   * PC gets a tunnel back to this one (main/llm-host.ts).
   */
  tunnel?: { nodeId: string; port: number };
  /** A key from 내 API 키: a platform's, or one a server of one's own asks for. */
  keyId?: string;
  /** For a small model: OpenCode reads nothing of ~/.claude, and a server of one's own names the conversation without thinking. */
  light?: true;
}

/** The ports each server listens on by default: Ollama, LM Studio, vLLM. */
export const LLM_PORTS = [11434, 1234, 8000] as const;

/** A typed address as the server's OpenAI root: scheme added, /v1 at the end, nothing after it. Undefined for anything that is not one. */
export function llmBaseUrl(typed: string): string | undefined {
  const text = typed.trim().replace(/\/+$/, "");
  const withScheme = /^https?:\/\//i.test(text) ? text : `http://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) return undefined;
  const path = url.pathname.replace(/\/+$/, "");
  const root = /\/v1$/.test(path) ? path : `${path}/v1`;
  const base = `${url.protocol}//${url.host}${root}`;
  // Only what can stand in a settings file and a curl line unquoted.
  return /^https?:\/\/[A-Za-z0-9.\-[\]:]+(?:\/[A-Za-z0-9._~-]+)*$/.test(base) ? base : undefined;
}

/** A model name a server reports and a launch line can carry: "qwen3-coder:30b", "anthropic/claude-sonnet-4.5". */
export const validModel = (model: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,159}$/.test(model);

/** The models a GET {base}/models answer lists, valid ones only. */
export function modelsFrom(body: unknown): string[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  return [...new Set(data.map((entry) => (entry as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === "string" && validModel(id)))];
}

/** What a platform lists that cannot hold a conversation: speech, pictures, embeddings, moderation. */
const notChat = /embed|tts|whisper|dall-e|image|audio|realtime|moderation|transcribe|davinci|babbage|guard|search-preview/i;

/**
 * The chat models a platform's model list names. Gemini lists its own shape;
 * OpenRouter says which take tools, and only those can work in OpenCode.
 */
export function platformModels(platform: LlmPlatform, body: unknown): string[] {
  if (platform === "google") {
    const models = (body as { models?: unknown } | null)?.models;
    if (!Array.isArray(models)) return [];
    return models
      .filter((one) => Array.isArray(one?.supportedGenerationMethods) && one.supportedGenerationMethods.includes("generateContent"))
      .map((one) => (typeof one?.name === "string" ? one.name.replace(/^models\//, "") : ""))
      .filter((id) => validModel(id) && !notChat.test(id));
  }
  if (platform === "openrouter") {
    const data = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) return [];
    return modelsFrom({ data: data.filter((one) => !Array.isArray(one?.supported_parameters) || one.supported_parameters.includes("tools")) });
  }
  return modelsFrom(body).filter((id) => !notChat.test(id));
}

/** The headers a platform's model list asks for, with this key. */
export function platformHeaders(platform: LlmPlatform, key: string): Record<string, string> {
  const auth = LLM_PLATFORMS[platform].auth;
  if (auth === "anthropic") return { "x-api-key": key, "anthropic-version": "2023-06-01" };
  if (auth === "google") return { "x-goog-api-key": key };
  return { authorization: `Bearer ${key}` };
}

/** The variable the key reaches OpenCode in: never on a launch line, never in its settings file. */
export const LLM_KEY_ENV = "LEPONS_LLM_KEY";
/** OpenCode's name for a server of one's own: Lepons' own, so a project's opencode.json does not change it. */
export const LLM_PROVIDER = "lepons_llm";

/**
 * OpenCode's settings for this connection, and what follows `-m`. The key is
 * named only as `{env:LEPONS_LLM_KEY}`. A platform's model is declared too,
 * for one newer than the model list OpenCode carries. Undefined for a model
 * or an address that was not checked.
 */
export function opencodeLlm(llm: Pick<LocalLlm, "platform" | "model" | "keyId" | "light">, reach?: string): { config: string; model: string } | undefined {
  if (!validModel(llm.model)) return undefined;
  const key = `{env:${LLM_KEY_ENV}}`;
  if (llm.platform) {
    const config = { $schema: "https://opencode.ai/config.json", provider: { [llm.platform]: { options: { apiKey: key }, models: { [llm.model]: {} } } } };
    return { config: JSON.stringify(config, null, 2), model: `${llm.platform}/${llm.model}` };
  }
  if (reach === undefined || llmBaseUrl(reach) !== reach) return undefined;
  const models: Record<string, unknown> = { [llm.model]: { name: llm.model, tool_call: true } };
  // A small model's thinking held the conversation's title up for minutes; the work keeps its thinking.
  if (llm.light) models["lepons-title"] = { id: llm.model, name: "title", options: { reasoningEffort: "none" } };
  const config = {
    $schema: "https://opencode.ai/config.json",
    provider: { [LLM_PROVIDER]: { npm: "@ai-sdk/openai-compatible", name: "Lepons", options: { baseURL: reach, ...(llm.keyId ? { apiKey: key } : {}) }, models } },
    ...(llm.light ? { small_model: `${LLM_PROVIDER}/lepons-title` } : {}),
  };
  return { config: JSON.stringify(config, null, 2), model: `${LLM_PROVIDER}/${llm.model}` };
}

/** What a key looks like in a list: its platform's own start, and its last four. */
export function keyHint(key: string): string {
  const start = /^(sk-or-v1-|sk-ant-|sk-proj-|sk-|gsk_|AIza)/.exec(key)?.[0] ?? "";
  return `${start}…${key.slice(-4)}`;
}

/** A pasted key, or undefined: one line of printable characters, as every platform issues them. */
export function cleanKey(typed: string): string | undefined {
  const key = typed.trim();
  return /^[\x21-\x7e]{8,512}$/.test(key) ? key : undefined;
}
