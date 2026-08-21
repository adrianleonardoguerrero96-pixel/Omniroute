import type { RegistryEntry } from "../../shared.ts";

export const openrouterProvider: RegistryEntry = {
  id: "openrouter",
  alias: "openrouter",
  format: "openai",
  executor: "default",
  baseUrl: "https://openrouter.ai/api/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  defaultContextLength: 128000,
  headers: {
    "HTTP-Referer": "https://endpoint-proxy.local",
    "X-Title": "Endpoint Proxy",
  },
  models: [
    { id: "auto", name: "Auto (Best Available)" },
    // Paid-combo fallbacks. OpenRouter is passthrough-style; without these
    // rows the hops have no catalog window and collapse out of large prompts
    // whenever a sibling hop (Kimi/Opus) is known-large.
    { id: "x-ai/grok-4.6-high", name: "Grok 4.6 High", contextLength: 500000 },
    { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", contextLength: 1000000 },
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", contextLength: 1048576 },
    { id: "google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview", contextLength: 1048576 },
  ],
};
