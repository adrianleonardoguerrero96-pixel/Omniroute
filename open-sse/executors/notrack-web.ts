/**
 * NotrackWebExecutor — notrack.ai cookie-auth Web Provider
 *
 * Routes chat requests through notrack.ai's `/api/dispatch` endpoint using the
 * user's logged-in browser session cookies (uid, si_usr_id, si_ses_id).
 *
 * API flow (verified against the upstream Python reference at /var/folders/.../notrack_main.py):
 *   1. POST /api/dispatch with formatted user_input → SSE stream
 *
 * Streaming format (SSE, `data: {json}` lines):
 *   - { type: "chat_meta",   chat_id }                    -- session id
 *   - { type: "user",        message_id }                -- user-message id
 *   - { type: "thinking" }                                -- reasoning tick
 *   - { type: "delta",       chunk: "..." }              -- content delta
 *   - { type: "message",      content: "...", turn: N }  -- full-snapshot fallback
 *
 * References (endpoint/payload shape lifted from the Python proxy):
 *   - /var/folders/.../notrack_main.py                    — endpoint, body shape, SSE event taxonomy
 */
import {
  BaseExecutor,
  mergeAbortSignals,
  mergeUpstreamExtraHeaders,
  type ExecuteInput,
} from "./base.ts";
import { FETCH_TIMEOUT_MS } from "../config/constants.ts";
import { buildErrorBody, sanitizeErrorMessage } from "../utils/error.ts";
import { extractCookieValue, stripCookieInputPrefix } from "@/lib/providers/webCookieAuth";

const NOTRACK_BASE = "https://notrack.ai";
const NOTRACK_DISPATCH_URL = `${NOTRACK_BASE}/api/dispatch`;

/**
 * User-Agent matches the upstream Python proxy (Chromium 150 Edge UA so the
 * notrack.ai front-door does not flag the request as a non-browser client).
 */
const NOTRACK_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0";

/** Hard cap mirrored from the upstream Python proxy (MAX_INPUT_CHARS = 3800). */
const MAX_INPUT_CHARS = 3800;

/** CJK block ranges — same table as the Python proxy's `_CJK_RANGES`. */
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x4e00, 0x9fff],
  [0x3400, 0x4dbf],
  [0x3040, 0x309f],
  [0x30a0, 0x30ff],
  [0xac00, 0xd7af],
  [0xff00, 0xffef],
];

interface OpenAIMessage {
  role?: string;
  content?: unknown;
  name?: string;
  tool_calls?: Array<Record<string, unknown>>;
  tool_call_id?: string;
}

interface OpenAITool {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: unknown;
  };
}

interface DispatchPayload {
  user_input: string;
  mode: string;
  model: string;
  persona: string;
  max_turns: number;
  chat_id: string | null;
  attachments: unknown[];
  regenerate: boolean;
  edit: boolean;
  edit_mid: string | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isEncryptedCredentialBlob(value: unknown): boolean {
  return typeof value === "string" && value.trim().startsWith("enc:v1:");
}

/**
 * Resolve the pasted cookie for a notrack-web connection. The dashboard add
 * flow stores it in `apiKey`; the bulk web-session importer (cookie-kind) keeps
 * `apiKey` null and stores the value in `providerSpecificData.cookie` — read
 * both so imported sessions authenticate.
 */
function resolveNotrackCookieSource(credentials: {
  apiKey?: string;
  providerSpecificData?: Record<string, unknown>;
}): string {
  if (credentials.apiKey && credentials.apiKey.trim()) return credentials.apiKey;
  const psdCookie = credentials.providerSpecificData?.cookie;
  return typeof psdCookie === "string" ? psdCookie : "";
}

/** Extract plain text from an OpenAI message `content` field. */
function extractContent(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") {
        parts.push(part);
        continue;
      }
      if (part && typeof part === "object") {
        const item = part as Record<string, unknown>;
        if (item.type === "text" && typeof item.text === "string") {
          parts.push(item.text);
          continue;
        }
        if (item.type === "input_text" && typeof item.text === "string") {
          parts.push(item.text);
          continue;
        }
        if (item.type === "image_url") {
          parts.push("[image]");
        }
      }
    }
    return parts.join("\n");
  }
  return String(content);
}

/**
 * Build the `Cookie` header value for notrack.ai from whatever the user pasted.
 *
 * When the pasted string contains the named session cookies (uid, si_usr_id,
 * si_ses_id) we rebuild a clean `Cookie` header with only those pairs — plus
 * `nt_session` (the `ntk_…` auth token set for logged-in accounts) when
 * present, so authenticated sessions are not silently downgraded to anonymous.
 * If any named cookie is missing we forward the raw pasted string verbatim.
 */
function buildNotrackCookie(rawApiKey: string): { cookie: string; hasSession: boolean } {
  const raw = stripCookieInputPrefix(rawApiKey || "");
  if (!raw) return { cookie: "", hasSession: false };

  const uid = raw.includes("uid=") ? extractCookieValue(raw, "uid") : "";
  const siUsrId = raw.includes("si_usr_id=") ? extractCookieValue(raw, "si_usr_id") : "";
  const siSesId = raw.includes("si_ses_id=") ? extractCookieValue(raw, "si_ses_id") : "";

  if (uid && siUsrId && siSesId) {
    const parts = [`uid=${uid}`, `si_usr_id=${siUsrId}`, `si_ses_id=${siSesId}`];
    const ntSession = raw.includes("nt_session=") ? extractCookieValue(raw, "nt_session") : "";
    if (ntSession) parts.push(`nt_session=${ntSession}`);
    return { cookie: parts.join("; "), hasSession: true };
  }

  return { cookie: raw, hasSession: raw.trim().length > 0 };
}

function isCjk(code: number): boolean {
  for (const [lo, hi] of CJK_RANGES) {
    if (code >= lo && code <= hi) return true;
  }
  return false;
}

/** CJK-aware token estimator (mirrors Python `_estimate_tokens`): CJK ≈ 1.5 chars/tok, Latin ≈ 4 chars/tok. */
function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (isCjk(text.charCodeAt(i))) cjk += 1;
  }
  const other = text.length - cjk;
  return Math.max(1, Math.ceil(cjk / 1.5 + other / 4));
}

/** Truncate a single string, keeping 70% head + 30% tail with a marker. */
function truncateMiddle(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const headLen = Math.floor(maxLen * 0.7);
  const tailLen = Math.max(maxLen - headLen - 20, 0);
  return `${text.slice(0, headLen)}\n[…truncated…]\n${text.slice(text.length - tailLen)}`;
}

function capitalize(role: string): string {
  if (!role) return "";
  return role[0].toUpperCase() + role.slice(1);
}

/**
 * Smart multi-turn truncation: keeps system + latest user + most recent
 * messages within `maxChars`, dropping oldest first. Mirrors the Python
 * `truncate_conversation` algorithm byte-for-byte.
 */
function truncateConversation(messages: OpenAIMessage[], maxChars: number): string {
  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");

  let latestUser: OpenAIMessage | null = null;
  for (let i = nonSystem.length - 1; i >= 0; i -= 1) {
    const m = nonSystem[i];
    if (m && m.role === "user") {
      latestUser = m;
      break;
    }
  }

  const recent: OpenAIMessage[] = nonSystem.filter((m) => m !== latestUser);
  recent.reverse();

  const parts: string[] = [];
  for (const m of systemMessages) {
    const text = extractContent(m.content).trim();
    if (text) parts.push(`[System]\n${text}`);
  }
  let budget = maxChars - parts.join("\n\n").length;

  let latestLine = "";
  if (latestUser) {
    const role = capitalize(latestUser.role || "");
    const content = extractContent(latestUser.content).trim();
    latestLine = `[${role}]\n${content}`;
    budget -= latestLine.length + 4;
  }

  const recentParts: string[] = [];
  for (const m of recent) {
    if (budget <= 100) break;
    const role = capitalize(m.role || "");
    const name = typeof m.name === "string" ? m.name : undefined;
    const tag = name ? `${role}(${name})` : role;
    const content = extractContent(m.content).trim();
    if (!content) continue;
    const line = `[${tag}]\n${content}`;
    if (line.length <= budget) {
      recentParts.unshift(line);
      budget -= line.length + 4;
    } else {
      const keep = budget - 30;
      if (keep > 80) {
        const head = Math.floor(keep * 0.6);
        const tail = Math.floor(keep * 0.4);
        const truncated = `${content.slice(0, head)}\n[…truncated…]\n${content.slice(content.length - tail)}`;
        recentParts.unshift(`[${tag}]\n${truncated}`);
      }
      break;
    }
  }

  const result = [...parts, ...recentParts];
  if (latestLine) result.push(latestLine);
  let joined = result.join("\n\n");
  if (joined.length > maxChars) joined = truncateMiddle(joined, maxChars);
  return joined;
}

/** Render a single OpenAI message into the inline role-tagged format. */
function renderMessageLine(m: OpenAIMessage): string | null {
  const roleRaw = m.role || "";
  const role = capitalize(roleRaw);
  const name = typeof m.name === "string" ? m.name : undefined;
  const tag = name ? `${role}(${name})` : role;

  // Tool result message — render as `[Tool Result: <name>]\n<content>`.
  if (roleRaw === "tool") {
    const toolName =
      typeof m.name === "string"
        ? m.name
        : typeof m.tool_call_id === "string"
          ? m.tool_call_id
          : "?";
    const content = extractContent(m.content).trim();
    return `[Tool Result: ${toolName}]\n${content}`;
  }

  // Assistant with tool_calls — emit a <tool_call> block per call, then any text.
  if (roleRaw === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
    const lines: string[] = [`[${tag}]`];
    for (const tc of m.tool_calls) {
      const fn =
        tc && typeof tc === "object" && typeof (tc as Record<string, unknown>).function === "object"
          ? ((tc as Record<string, unknown>).function as Record<string, unknown>)
          : null;
      const fnName = fn && typeof fn.name === "string" ? fn.name : "";
      const fnArgs = fn && typeof fn.arguments === "string" ? fn.arguments : "{}";
      const callJson = `{"name":"${fnName}","arguments":${fnArgs}}`;
      // U+200B inside the closing tag matches the Python reference's literal envelope.
      lines.push(`<\u200btool_call>${callJson}</\u200btool_call>`);
    }
    const text = extractContent(m.content).trim();
    if (text) lines.push(text);
    return lines.join("\n\n");
  }

  const content = extractContent(m.content).trim();
  if (!content) return null;
  return `[${tag}]\n${content}`;
}

/** Build the `user_input` string for a tools-enabled request. */
function messagesToInputWithTools(messages: OpenAIMessage[], toolSystemPrompt: string): string {
  const lines: string[] = [];
  if (toolSystemPrompt) {
    lines.push(`[System]\n${toolSystemPrompt}`);
  }
  for (const m of messages) {
    const line = renderMessageLine(m);
    if (line !== null) lines.push(line);
  }
  let joined = lines.join("\n\n");
  if (joined.length > MAX_INPUT_CHARS) joined = truncateMiddle(joined, MAX_INPUT_CHARS);
  return joined;
}

/** Build the `user_input` string for a tools-free request (mirrors Python `messages_to_input`). */
function messagesToInput(messages: OpenAIMessage[]): string {
  if (messages.length === 0) return "";

  if (messages.length === 1 && messages[0]?.role === "user") {
    const content = extractContent(messages[0].content);
    if (content.length > MAX_INPUT_CHARS) return truncateMiddle(content, MAX_INPUT_CHARS);
    return content;
  }

  if (messages.length === 2 && messages[0]?.role === "system" && messages[1]?.role === "user") {
    const sysText = extractContent(messages[0].content).trim();
    const userText = extractContent(messages[1].content).trim();
    const result = sysText ? `(请遵循以下指引回答：${sysText})\n\n${userText}` : userText;
    if (result.length > MAX_INPUT_CHARS) return truncateConversation(messages, MAX_INPUT_CHARS);
    return result;
  }

  return truncateConversation(messages, MAX_INPUT_CHARS);
}

/** Build the tool contract system prompt describing how to emit `<tool_call>` blocks. */
function buildToolSystemPrompt(tools: OpenAITool[], toolChoice: unknown): string {
  const lines: string[] = [
    "The client provides tools beyond your built-in ones. They are NOT in your native " +
      "tool registry; they are invoked via a plain-text protocol: the client parses your " +
      "reply and executes the tool on the user machine. Treat these client tools as fully " +
      "available to you; never claim they are unavailable.",
    "",
    "To call a tool, emit a single line containing a <\\u200btool_call> block with a JSON " +
      'object of the form `{"name": "<tool_name>", "arguments": { ... } }`. Example:',
    '<\u200btool_call>{"name": "get_weather", "arguments": {"city": "Tokyo"}}</\u200btool_call>',
    "",
    "When a tool result comes back, it will be rendered as `[Tool Result: <tool_name>]\\n<content>`. " +
      "Use that content to continue the answer. Only emit one <\\u200btool_call> block when you " +
      "actually want to call a tool; otherwise answer normally.",
    "",
    "Available tools:",
  ];

  for (const t of tools) {
    const fn = t.function;
    if (!fn || typeof fn.name !== "string") continue;
    const desc = typeof fn.description === "string" && fn.description ? fn.description : "";
    let params = "";
    if (fn.parameters !== undefined) {
      try {
        params = JSON.stringify(fn.parameters);
      } catch {
        params = "";
      }
    }
    lines.push(
      `- ${fn.name}${desc ? `: ${desc}` : ""}${params ? `\n  parameters: ${params}` : ""}`
    );
  }

  if (typeof toolChoice === "string" && toolChoice !== "auto" && toolChoice !== "none") {
    lines.push("", `Tool choice for this request: ${toolChoice}`);
  }

  return lines.join("\n");
}

/**
 * Build the sampling-parameter prefix the Python proxy prepends to user_input.
 * Keeps the exact phrasing the upstream proxy uses so the model sees a familiar
 * shape and a fixed-style answer.
 */
function buildSamplingPrefix(body: Record<string, unknown>): string {
  const hints: string[] = [];

  const temp = body.temperature;
  if (typeof temp === "number" && Number.isFinite(temp)) {
    const tag =
      temp < 0.5
        ? "be focused and deterministic"
        : temp > 1.2
          ? "be creative and varied"
          : "balance focus and creativity";
    hints.push(`(temperature=${temp}: ${tag})`);
  }

  const topP = body.top_p;
  if (typeof topP === "number" && Number.isFinite(topP)) {
    hints.push(
      `(top_p=${topP}: ${topP < 0.5 ? "stick to highest-probability responses" : "consider diverse options"})`
    );
  }

  const maxTokens = body.max_tokens;
  if (typeof maxTokens === "number" && Number.isFinite(maxTokens)) {
    hints.push(`(max_tokens=${maxTokens}: keep response under ~${maxTokens} tokens)`);
  }

  const freqPenalty = body.frequency_penalty;
  if (typeof freqPenalty === "number" && freqPenalty !== 0) {
    hints.push(
      `(frequency_penalty=${freqPenalty}: ${freqPenalty > 0 ? "reduce repetition of frequent tokens" : "encourage repetition"})`
    );
  }

  const presPenalty = body.presence_penalty;
  if (typeof presPenalty === "number" && presPenalty !== 0) {
    hints.push(
      `(presence_penalty=${presPenalty}: ${presPenalty > 0 ? "encourage new topics, reduce repetition" : "stay on topic"})`
    );
  }

  const seed = body.seed;
  if (typeof seed === "number" && Number.isFinite(seed)) {
    hints.push(`(seed=${seed}: be as deterministic as possible)`);
  }

  const responseFormat = body.response_format;
  if (responseFormat && typeof responseFormat === "object") {
    const fmt = responseFormat as Record<string, unknown>;
    if (fmt.type === "json_object") {
      hints.push(
        "(response_format=json_object: you MUST respond with ONLY valid JSON, no markdown, no explanation, just the JSON object)"
      );
    } else if (fmt.type === "json_schema") {
      const schema =
        fmt.json_schema && typeof fmt.json_schema === "object"
          ? (fmt.json_schema as Record<string, unknown>).schema
          : null;
      if (schema) {
        try {
          const schemaStr = JSON.stringify(schema);
          const preview = schemaStr.length > 500 ? `${schemaStr.slice(0, 500)}...` : schemaStr;
          hints.push(
            "(response_format=json_schema: you MUST respond with ONLY valid JSON matching this schema, no markdown, no explanation):"
          );
          hints.push(preview);
        } catch {
          /* malformed schema → skip */
        }
      }
    }
  }

  const stop = body.stop;
  if (Array.isArray(stop) && stop.length > 0) {
    const joined = stop.filter((s) => typeof s === "string" || typeof s === "number").join(" / ");
    if (joined) hints.push(`(stop: end your response before any of these sequences: ${joined})`);
  } else if (typeof stop === "string" && stop) {
    hints.push(`(stop: end your response before: ${stop})`);
  }

  return hints.length > 0 ? `${hints.join(" ")}\n\n` : "";
}

/**
 * Best-effort JSON extraction for `response_format=json_object` / `json_schema`.
 * Mirrors the Python `extract_json` helper.
 */
function extractJsonObject(raw: string): unknown | null {
  if (!raw) return null;
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text
      .replace(/^```(?:json|javascript|js|python)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  const candidate = text.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/**
 * Parse `<tool_call>{...}</tool_call>` envelopes (zero-width-space variant
 * used by the Python reference) out of an upstream response into OpenAI
 * `tool_calls`. Mirrors the Python `parse_tool_calls` shape.
 */
function parseToolCallBlocks(
  rawContent: string,
  idSeed: string
): { content: string; toolCalls: Array<Record<string, unknown>> | null } {
  if (!rawContent || !rawContent.includes("<\u200btool_call")) {
    return { content: rawContent || "", toolCalls: null };
  }

  const TAG_OPEN = "<\u200btool_call>";
  const TAG_CLOSE = "</\u200btool_call>";
  const re = new RegExp(`${TAG_OPEN}\\s*([\\s\\S]*?)\\s*${TAG_CLOSE}`, "g");

  const calls: Array<Record<string, unknown>> = [];
  const ranges: Array<[number, number]> = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(rawContent)) !== null) {
    const body = match[1].trim();
    let parsed: Record<string, unknown> | null = null;
    try {
      const v = JSON.parse(body);
      if (v && typeof v === "object" && !Array.isArray(v)) parsed = v as Record<string, unknown>;
    } catch {
      continue;
    }
    const name = typeof parsed.name === "string" ? parsed.name : null;
    if (!name) continue;
    let args = "{}";
    if (typeof parsed.arguments === "string") {
      args = parsed.arguments;
    } else if (parsed.arguments !== undefined) {
      try {
        args = JSON.stringify(parsed.arguments);
      } catch {
        args = "{}";
      }
    }
    calls.push({
      id: `${idSeed}_${calls.length}`,
      type: "function",
      function: { name, arguments: args },
    });
    ranges.push([match.index, re.lastIndex]);
  }

  if (calls.length === 0) return { content: rawContent, toolCalls: null };

  // Strip the recognized ranges from the cleaned text (highest offset first).
  ranges.sort((a, b) => b[0] - a[0]);
  let cleaned = rawContent;
  for (const [start, end] of ranges) {
    cleaned = `${cleaned.slice(0, start)}${cleaned.slice(end)}`;
  }
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return { content: cleaned, toolCalls: calls };
}

interface NotrackEvent {
  type?: string;
  chat_id?: string;
  message_id?: string;
  chunk?: string;
  content?: string;
  turn?: number;
}

/** Parse a single `data:` line; returns null for non-data / `[DONE]` / malformed. */
function parseNotrackDataLine(line: string): NotrackEvent | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]" || !payload.startsWith("{")) return null;
  try {
    return JSON.parse(payload) as NotrackEvent;
  } catch {
    return null;
  }
}

// ── Executor ────────────────────────────────────────────────────────────────

export class NotrackWebExecutor extends BaseExecutor {
  constructor() {
    super("notrack-web", { id: "notrack-web", baseUrl: NOTRACK_DISPATCH_URL });
  }

  private errorResponse(
    status: number,
    message: string,
    url: string,
    details?: unknown
  ): {
    response: Response;
    url: string;
    headers: Record<string, string>;
    transformedBody: unknown;
  } {
    return {
      response: new Response(JSON.stringify(buildErrorBody(status, message, details)), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
      url,
      headers: {},
      transformedBody: undefined,
    };
  }

  async execute(input: ExecuteInput): Promise<{
    response: Response;
    url: string;
    headers: Record<string, string>;
    transformedBody: unknown;
  }> {
    const { body, stream, credentials, signal, log, upstreamExtraHeaders } = input;
    const bodyObj = (body || {}) as Record<string, unknown>;
    const messages = bodyObj.messages;

    if (!Array.isArray(messages) || messages.length === 0) {
      return this.errorResponse(400, "Missing or empty messages array", NOTRACK_DISPATCH_URL);
    }

    const rawCookieSource = resolveNotrackCookieSource(credentials);
    if (isEncryptedCredentialBlob(rawCookieSource)) {
      return this.errorResponse(
        401,
        "Notrack credentials are encrypted but STORAGE_ENCRYPTION_KEY is not loaded. " +
          "Restore the encryption key or re-save the Notrack cookie.",
        NOTRACK_DISPATCH_URL
      );
    }

    const { cookie, hasSession } = buildNotrackCookie(rawCookieSource);
    if (!hasSession) {
      return this.errorResponse(
        401,
        "Notrack requires a session cookie. Log in to notrack.ai, open " +
          "DevTools → Network → any /api request → Request Headers → Cookie, " +
          "and paste the full Cookie header (it must contain uid, si_usr_id, and si_ses_id).",
        NOTRACK_DISPATCH_URL
      );
    }

    const typedMessages = messages as OpenAIMessage[];

    // ── Tools contract ─────────────────────────────────────────────────────
    const toolsRaw = Array.isArray(bodyObj.tools) ? (bodyObj.tools as OpenAITool[]) : [];
    const toolChoice = bodyObj.tool_choice;
    const useTools = toolsRaw.length > 0 && toolChoice !== "none";
    const toolSystemPrompt = useTools ? buildToolSystemPrompt(toolsRaw, toolChoice) : "";

    // ── Build user_input ──────────────────────────────────────────────────
    const baseInput = useTools
      ? messagesToInputWithTools(typedMessages, toolSystemPrompt)
      : messagesToInput(typedMessages);

    const samplingPrefix = buildSamplingPrefix(bodyObj);
    const userInput = `${samplingPrefix}${baseInput}`;
    if (!userInput.trim()) {
      return this.errorResponse(
        400,
        "Empty prompt after processing messages",
        NOTRACK_DISPATCH_URL
      );
    }

    // ── Build dispatch payload ────────────────────────────────────────────
    const dispatchPayload: DispatchPayload = {
      user_input: userInput,
      mode: typeof bodyObj.notrack_mode === "string" ? bodyObj.notrack_mode : "usual",
      model: "C",
      persona: "normal",
      max_turns:
        typeof bodyObj.notrack_max_turns === "number" && Number.isFinite(bodyObj.notrack_max_turns)
          ? bodyObj.notrack_max_turns
          : 6,
      chat_id:
        typeof bodyObj.notrack_chat_id === "string" && bodyObj.notrack_chat_id
          ? bodyObj.notrack_chat_id
          : null,
      attachments: Array.isArray(bodyObj.notrack_attachments) ? bodyObj.notrack_attachments : [],
      regenerate: bodyObj.notrack_regenerate === true,
      edit: false,
      edit_mid: null,
    };

    // ── Upstream headers ──────────────────────────────────────────────────
    const baseHeaders: Record<string, string> = {
      "content-type": "application/json",
      accept: "*/*",
      "accept-language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
      origin: NOTRACK_BASE,
      referer: `${NOTRACK_BASE}/zh-CN/chat`,
      "user-agent": NOTRACK_USER_AGENT,
      cookie,
    };
    mergeUpstreamExtraHeaders(baseHeaders, upstreamExtraHeaders);

    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const combinedSignal = signal ? mergeAbortSignals(signal, timeoutSignal) : timeoutSignal;

    // ── Call upstream ─────────────────────────────────────────────────────
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(NOTRACK_DISPATCH_URL, {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify(dispatchPayload),
        signal: combinedSignal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log?.error?.("NOTRACK-WEB", `Fetch failed: ${message}`);
      const status = err instanceof Error && err.name === "TimeoutError" ? 504 : 502;
      return this.errorResponse(
        status,
        `Notrack connection failed: ${sanitizeErrorMessage(message)}`,
        NOTRACK_DISPATCH_URL
      );
    }

    if (!upstreamResponse.ok) {
      const upstreamStatus = upstreamResponse.status;
      const text = await upstreamResponse.text().catch(() => "");
      // Map upstream 4xx codes to themselves (operator-actionable auth / rate /
      // request-shape problems); collapse upstream 5xx into 502 Bad Gateway so
      // clients see a uniform "upstream misbehaved" surface.
      const status = upstreamStatus >= 500 ? 502 : upstreamStatus;
      let message = `Notrack returned HTTP ${upstreamStatus}`;
      if (upstreamStatus === 401 || upstreamStatus === 403) {
        message =
          "Notrack auth failed — your uid/si_usr_id/si_ses_id cookies may be missing or expired. " +
          "Log in to notrack.ai and re-paste your Cookie header.";
      } else if (upstreamStatus === 429) {
        message = "Notrack rate limited. Wait a moment and retry.";
      } else if (upstreamStatus >= 500) {
        message = "Notrack upstream is currently unavailable. Try again in a moment.";
      }
      if (text) {
        const sanitized = sanitizeErrorMessage(text);
        if (sanitized) message = `${message}: ${sanitized}`;
      }
      return this.errorResponse(status, message, NOTRACK_DISPATCH_URL, {
        body: text.slice(0, 500),
      });
    }

    if (!upstreamResponse.body) {
      return this.errorResponse(502, "Notrack returned empty response body", NOTRACK_DISPATCH_URL);
    }

    // ── Stream vs collect ─────────────────────────────────────────────────
    const id = `chatcmpl-notrack-${crypto.randomUUID().slice(0, 12)}`;
    const created = Math.floor(Date.now() / 1000);
    const modelOut = resolvedModel(input.model);
    const streamOptions =
      bodyObj.stream_options && typeof bodyObj.stream_options === "object"
        ? (bodyObj.stream_options as Record<string, unknown>)
        : null;
    const includeUsage = streamOptions?.include_usage === true;

    if (stream) {
      return {
        response: new Response(
          transformNotrackStream(
            upstreamResponse.body,
            modelOut,
            id,
            created,
            userInput,
            includeUsage,
            signal,
            log
          ),
          {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "X-Accel-Buffering": "no",
            },
          }
        ),
        url: NOTRACK_DISPATCH_URL,
        headers: baseHeaders,
        transformedBody: dispatchPayload,
      };
    }

    const { content, chatMeta, userMsgId, assistantTurn } = await collectNotrackResponse(
      upstreamResponse.body,
      signal,
      log
    );

    let finalContent = content;
    let parsedToolCalls: Array<Record<string, unknown>> | null = null;
    let finishReason: "stop" | "tool_calls" = "stop";

    if (useTools) {
      const parsed = parseToolCallBlocks(finalContent, `call-${id.slice(-8)}`);
      finalContent = parsed.content;
      parsedToolCalls = parsed.toolCalls;
      if (parsedToolCalls && parsedToolCalls.length > 0) finishReason = "tool_calls";
    }

    // response_format handling — best-effort JSON extraction / stringify.
    const responseFormat = bodyObj.response_format;
    if (
      responseFormat &&
      typeof responseFormat === "object" &&
      ((responseFormat as Record<string, unknown>).type === "json_object" ||
        (responseFormat as Record<string, unknown>).type === "json_schema")
    ) {
      const extracted = extractJsonObject(finalContent);
      if (extracted !== null) {
        try {
          finalContent = JSON.stringify(extracted);
        } catch {
          /* keep original text on serialization failure */
        }
      }
    }

    const completionTokens = estimateTokens(finalContent);
    const promptTokens = estimateTokens(userInput);

    const messagePayload: Record<string, unknown> = {
      role: "assistant",
      refusal: null,
    };
    if (parsedToolCalls && parsedToolCalls.length > 0) {
      messagePayload.content = finalContent || null;
      messagePayload.tool_calls = parsedToolCalls;
    } else {
      messagePayload.content = finalContent;
    }

    return {
      response: new Response(
        JSON.stringify({
          id,
          object: "chat.completion",
          created,
          model: modelOut,
          system_fingerprint: "fp_notrack",
          choices: [
            {
              index: 0,
              message: messagePayload,
              logprobs: null,
              finish_reason: finishReason,
            },
          ],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
          notrack: {
            chat_id: chatMeta,
            user_message_id: userMsgId,
            assistant_turn: assistantTurn,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      ),
      url: NOTRACK_DISPATCH_URL,
      headers: baseHeaders,
      transformedBody: dispatchPayload,
    };
  }
}

/** Resolve the model id we echo back in the OpenAI response (canonicalize aliases). */
function resolvedModel(model: string | undefined): string {
  if (!model) return "notrack-c";
  const lower = model.toLowerCase();
  if (lower === "ntw" || lower === "notrack" || lower === "c" || lower === "notrack-c") {
    return "notrack-c";
  }
  return model;
}

// ── SSE translation helpers ─────────────────────────────────────────────────

function transformNotrackStream(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  id: string,
  created: number,
  userInput: string,
  includeUsage: boolean,
  signal: AbortSignal | null | undefined,
  log: ExecuteInput["log"]
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let roleEmitted = false;
  let anyDelta = false;
  let totalChars = 0;
  let fullText = "";

  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader();
      let buffer = "";

      const emit = (delta: Record<string, unknown>, finish?: string | null) => {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              system_fingerprint: "fp_notrack",
              choices: [{ index: 0, delta, finish_reason: finish ?? null }],
            })}\n\n`
          )
        );
      };

      const ensureRole = () => {
        if (!roleEmitted) {
          roleEmitted = true;
          emit({ role: "assistant", content: "" });
        }
      };

      const handleEvent = (event: NotrackEvent) => {
        if (event.type === "thinking") {
          ensureRole();
          emit({ reasoning: "[thinking]" });
          return;
        }
        if (event.type === "delta" && typeof event.chunk === "string") {
          anyDelta = true;
          totalChars += event.chunk.length;
          fullText += event.chunk;
          ensureRole();
          emit({ content: event.chunk });
          return;
        }
        if (event.type === "message" && typeof event.content === "string" && !anyDelta) {
          anyDelta = true;
          totalChars += event.content.length;
          fullText += event.content;
          ensureRole();
          emit({ content: event.content });
        }
      };

      const processLine = (rawLine: string) => {
        const event = parseNotrackDataLine(rawLine.replace(/\r$/, ""));
        if (event) handleEvent(event);
      };

      try {
        while (true) {
          if (signal?.aborted) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const rawLine of lines) processLine(rawLine);
        }
        // A stream may end right after a final unterminated data line — flush it.
        buffer += decoder.decode();
        if (buffer) processLine(buffer);
        buffer = "";
      } catch (err) {
        log?.error?.("NOTRACK-WEB", `Stream parse error: ${err}`);
      } finally {
        ensureRole();
        emit({}, "stop");
        if (includeUsage) {
          const completionTokens = estimateTokens(fullText || "x".repeat(totalChars));
          const promptTokens = estimateTokens(userInput);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                system_fingerprint: "fp_notrack",
                choices: [],
                usage: {
                  prompt_tokens: promptTokens,
                  completion_tokens: completionTokens,
                  total_tokens: promptTokens + completionTokens,
                },
              })}\n\n`
            )
          );
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        reader.releaseLock();
      }
    },
  });
}

interface CollectedResponse {
  content: string;
  chatMeta: string | null;
  userMsgId: string | null;
  assistantTurn: number | null;
}

async function collectNotrackResponse(
  upstream: ReadableStream<Uint8Array>,
  signal: AbortSignal | null | undefined,
  log: ExecuteInput["log"]
): CollectedResponse {
  const decoder = new TextDecoder();
  const reader = upstream.getReader();
  let buffer = "";
  let content = "";
  let fallback = "";
  let chatMeta: string | null = null;
  let userMsgId: string | null = null;
  let assistantTurn: number | null = null;
  let anyDelta = false;

  const handleEvent = (event: NotrackEvent) => {
    if (event.type === "chat_meta" && typeof event.chat_id === "string") {
      chatMeta = event.chat_id;
      return;
    }
    if (event.type === "user" && typeof event.message_id === "string") {
      userMsgId = event.message_id;
      return;
    }
    if (event.type === "delta") {
      if (typeof event.chunk === "string") {
        anyDelta = true;
        content += event.chunk;
      }
      if (typeof event.turn === "number") assistantTurn = event.turn;
      return;
    }
    if (event.type === "message") {
      if (typeof event.content === "string") fallback = event.content;
      if (typeof event.turn === "number") assistantTurn = event.turn;
    }
  };

  const processLine = (rawLine: string) => {
    const event = parseNotrackDataLine(rawLine.replace(/\r$/, ""));
    if (event) handleEvent(event);
  };

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const rawLine of lines) processLine(rawLine);
    }
    // A stream may end right after a final unterminated data line — flush it.
    buffer += decoder.decode();
    if (buffer) processLine(buffer);
    buffer = "";
  } catch (err) {
    log?.error?.("NOTRACK-WEB", `Collect parse error: ${err}`);
  } finally {
    reader.releaseLock();
  }

  const finalContent = anyDelta ? content : content || fallback;
  return {
    content: finalContent,
    chatMeta,
    userMsgId,
    assistantTurn,
  };
}
