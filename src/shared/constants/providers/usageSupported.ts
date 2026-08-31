/**
 * usageSupported.ts — registration list of providers whose usage/quota API
 * is accepted by the dashboard and server routes.
 *
 * Extracted from `providers.ts` so that light consumers (e.g. the
 * provider-plugin manifest, `providerQuotaVisibility.ts`) can read the list
 * without pulling the ~12-module provider registry. Pure data — no imports,
 * no module state — so it cannot introduce a cycle. `providers.ts` re-exports
 * both the value and the derived type, so every existing import path keeps
 * working unchanged.
 */

// Providers that support usage/quota API
export const USAGE_SUPPORTED_PROVIDERS = [
  "antigravity",
  "agy",
  "kiro",
  "amazon-q",
  "github",
  "codex",
  "claude",
  "cursor",
  "qoder",
  "kimi-coding",
  "kimi-coding-apikey",
  "glm",
  "glm-cn",
  "zai",
  "glmt",
  "opencode-go",
  "ollama-cloud",
  "minimax",
  "minimax-cn",
  "crof",
  "nanogpt",
  "deepseek",
  "xiaomi-mimo",
  "xiaomi-mimo-token-plan",
  "vertex",
  "vertex-partner",
  "codebuddy-cn",
  // PromptQL playground credits (getCreditSummary → USD micros)
  "promptql",
  "pql",
  // Adobe Firefly web (cookie/JWT as apikey) — GET firefly.adobe.io/v1/credits/balance
  "adobe-firefly",
  "firefly",
  "hyperagent",
  "ha",
  // xAI OAuth (Grok) weekly quota (id + public alias, same pattern as ha/agy)
  "xai-oauth",
  "xao",
  // Grok Build subscription, billing credits, and auto top-up status
  "grok-cli",
  // Firecrawl team credits (GET /v2/team/credit-usage)
  "firecrawl",
  // Volcano Ark Plan subscriptions (agent-plan / coding-plan)
  "volcengine-agent-plan",
  "volcengine-coding-plan",
  // Command Code credits + 5h/weekly rolling windows
  "command-code",
  "conol-web",
  "cnl",
  // Alibaba Coding Plan triple-window quota (#9603 UI gap — fetcher existed, list entry missing)
  "bailian-coding-plan",
  // Qwen Cloud / Model Studio personal Token Plan (cookie-authenticated console gateway)
  "qwen-cloud-token-plan",
  // AgentRouter (New-API) console balance quota (consoleApiKey + newApiUserId)
  "agentrouter",
] as const;

export type UsageSupportedProvider = (typeof USAGE_SUPPORTED_PROVIDERS)[number];
