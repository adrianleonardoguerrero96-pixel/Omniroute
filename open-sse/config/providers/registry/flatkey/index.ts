import type { RegistryEntry } from "../../shared.ts";

// Flatkey (#4239 class) — OpenAI-compatible aggregator/router at router.flatkey.ai.
// Bearer auth, OpenAI-compatible, working `/v1/models` (97 live models as of
// 2026-09-03). Standard named OpenAI-style provider, zenmux shape.
//
// Seed list is a fallback ONLY — the provider is in NAMED_OPENAI_STYLE_PROVIDERS
// so `/models` serves the live upstream catalog and falls back here on error.
// All seed ids verified against the live catalog; contextLengths are canonical
// upstream values (the /v1/models response does not carry them).
export const flatkeyProvider: RegistryEntry = {
  id: "flatkey",
  alias: "fk",
  format: "openai",
  executor: "default",
  baseUrl: "https://router.flatkey.ai/v1/chat/completions",
  modelsUrl: "https://router.flatkey.ai/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  defaultContextLength: 128000,
  models: [
    {
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5 (Flatkey)",
      contextLength: 200000,
      toolCalling: true,
      supportsReasoning: true,
    },
    {
      id: "claude-opus-5",
      name: "Claude Opus 5 (Flatkey)",
      contextLength: 200000,
      toolCalling: true,
      supportsReasoning: true,
    },
    {
      id: "claude-haiku-4-5-20251001",
      name: "Claude Haiku 4.5 (Flatkey)",
      contextLength: 200000,
      toolCalling: true,
    },
    { id: "gpt-5.5", name: "GPT-5.5 (Flatkey)", contextLength: 400000, toolCalling: true, supportsReasoning: true },
    { id: "gpt-5.4-mini", name: "GPT-5.4 Mini (Flatkey)", contextLength: 400000, toolCalling: true, supportsReasoning: true },
    {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro (Flatkey)",
      contextLength: 163840,
      toolCalling: true,
      supportsReasoning: true,
    },
    {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash (Flatkey)",
      contextLength: 163840,
      toolCalling: true,
      supportsReasoning: true,
    },
    {
      id: "gemini-2.5-pro",
      name: "Gemini 2.5 Pro (Flatkey)",
      contextLength: 1048576,
      toolCalling: true,
      supportsReasoning: true,
    },
    {
      id: "gemini-2.5-flash-lite",
      name: "Gemini 2.5 Flash Lite (Flatkey)",
      contextLength: 1048576,
      toolCalling: true,
    },
    { id: "kimi-k2.6", name: "Kimi K2.6 (Flatkey)", contextLength: 262144, toolCalling: true, supportsReasoning: true },
  ],
};
