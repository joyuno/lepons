import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanKey, keyHint, llmBaseUrl, modelsFrom, opencodeLlm, platformHeaders, platformModels, validModel } from "./local-llm.ts";

test("a typed address becomes the server's OpenAI root", () => {
  assert.equal(llmBaseUrl("192.168.0.5:11434"), "http://192.168.0.5:11434/v1");
  assert.equal(llmBaseUrl("http://localhost:1234/v1/"), "http://localhost:1234/v1");
  assert.equal(llmBaseUrl("https://gpu.lan:8000"), "https://gpu.lan:8000/v1");
  assert.equal(llmBaseUrl("http://[::1]:11434"), "http://[::1]:11434/v1");
  assert.equal(llmBaseUrl("http://host:8000/openai"), "http://host:8000/openai/v1");
});

test("anything that could break a launch line, or is not a plain server, is refused", () => {
  for (const bad of ["", "ftp://x", "http://user:pw@host:1", "http://host:1/?a=b", "http://host:1/#x", "http://host:1/a b", "http://host;rm -rf /:1", "http://host:1/$(id)", "http://host:1/a&b"]) {
    assert.equal(llmBaseUrl(bad), undefined, bad);
  }
});

test("model names a server reports, and none that could break a line", () => {
  assert.equal(validModel("qwen3-coder:30b"), true);
  assert.equal(validModel("Qwen/Qwen3-Coder-30B-A3B-Instruct"), true);
  assert.equal(validModel("a b"), false);
  assert.equal(validModel("x&calc"), false);
  assert.equal(validModel("--yolo"), false, "never read as a flag");
  assert.deepEqual(modelsFrom({ data: [{ id: "qwen3-coder:30b" }, { id: "bad name" }, { id: "qwen3-coder:30b" }, {}] }), ["qwen3-coder:30b"]);
  assert.deepEqual(modelsFrom({ error: "x" }), []);
});

test("a platform's list keeps the models that can hold a conversation with tools", () => {
  assert.deepEqual(platformModels("openai", { data: [{ id: "gpt-5" }, { id: "text-embedding-3-small" }, { id: "whisper-1" }, { id: "gpt-image-1" }] }), ["gpt-5"]);
  assert.deepEqual(platformModels("openrouter", { data: [
    { id: "anthropic/claude-sonnet-4.5", supported_parameters: ["tools", "temperature"] },
    { id: "some/no-tools", supported_parameters: ["temperature"] },
  ] }), ["anthropic/claude-sonnet-4.5"]);
  assert.deepEqual(platformModels("google", { models: [
    { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
    { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
  ] }), ["gemini-2.5-pro"]);
  assert.deepEqual(platformModels("google", { error: {} }), []);
  assert.deepEqual(platformHeaders("anthropic", "k"), { "x-api-key": "k", "anthropic-version": "2023-06-01" });
  assert.deepEqual(platformHeaders("groq", "k"), { authorization: "Bearer k" });
});

test("OpenCode is told the server or platform, and only the name of where the key is", () => {
  const own = opencodeLlm({ model: "qwen3.5:4b" }, "http://127.0.0.1:50123/v1")!;
  assert.equal(own.model, "lepons_llm/qwen3.5:4b");
  const config = JSON.parse(own.config);
  assert.equal(config.provider.lepons_llm.options.baseURL, "http://127.0.0.1:50123/v1");
  assert.equal(config.provider.lepons_llm.options.apiKey, undefined, "no key asked for, none named");
  assert.equal(config.small_model, undefined);

  const light = JSON.parse(opencodeLlm({ model: "qwen3.5:4b", light: true, keyId: "k1" }, "http://x:1/v1")!.config);
  assert.equal(light.provider.lepons_llm.options.apiKey, "{env:LEPONS_LLM_KEY}");
  assert.equal(light.small_model, "lepons_llm/lepons-title");
  assert.equal(light.provider.lepons_llm.models["lepons-title"].options.reasoningEffort, "none", "the title is made without thinking");

  const api = opencodeLlm({ platform: "openrouter", model: "anthropic/claude-sonnet-4.5", keyId: "k" })!;
  assert.equal(api.model, "openrouter/anthropic/claude-sonnet-4.5");
  assert.deepEqual(JSON.parse(api.config).provider, { openrouter: { options: { apiKey: "{env:LEPONS_LLM_KEY}" }, models: { "anthropic/claude-sonnet-4.5": {} } } });

  assert.equal(opencodeLlm({ model: "m" }, "http://x:1/v1 & calc"), undefined, "never an unchecked address");
  assert.equal(opencodeLlm({ model: "m" }), undefined, "a server of one's own needs where it is reached");
  assert.equal(opencodeLlm({ model: "a b", platform: "openai" }), undefined);
});

test("a key is shown by its start and last four, and only a plain one is taken", () => {
  assert.equal(keyHint("sk-or-v1-abcdef123456wxyz"), "sk-or-v1-…wxyz");
  assert.equal(keyHint("AIzaSyD-whatever9876"), "AIza…9876");
  assert.equal(keyHint("plainkey12345678"), "…5678");
  assert.equal(cleanKey("  sk-abc12345  "), "sk-abc12345");
  assert.equal(cleanKey("sk-abc 12345"), undefined);
  assert.equal(cleanKey("short"), undefined);
  assert.equal(cleanKey("sk-abc12345\n"), "sk-abc12345");
});
