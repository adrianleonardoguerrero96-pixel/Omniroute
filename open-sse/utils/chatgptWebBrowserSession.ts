import { Buffer } from "node:buffer";

import type { ChatGptWebResolvedAttachment } from "./chatgptWebAttachments.ts";
import {
  executeChatGptWebFirstPartyTurn,
  type ChatGptWebFirstPartyRequest,
  type ChatGptWebUiSelection,
} from "./chatgptWebFirstParty.ts";
import { ChatGptWebDeltaV1Decoder, parseChatGptWebEncodedItem } from "./chatgptWebDeltaV1.ts";
import {
  ChatGptWebTopicStream,
  parseChatGptWebConversationHandoff,
} from "./chatgptWebTransport.ts";

type JsonRecord = Record<string, unknown>;
type Page = import("playwright").Page;

const CHATGPT_WEB_ORIGIN = "https://chatgpt.com";
const DEFAULT_TURN_TIMEOUT_MS = 180_000;
const MAX_BUFFERED_FRAMES = 2_048;
const MAX_BUFFERED_FRAME_BYTES = 16 * 1024 * 1024;

export interface ChatGptWebBrowserSessionHandlers {
  onBootstrap(sseText: string): void;
  onWebSocketFrame(frameText: string): void;
  onError(error: Error): void;
}

/**
 * Boundary owned by a logged-in first-party browser page.
 *
 * The implementation must let ChatGPT's own page execute Sentinel, Turnstile, proof-of-work,
 * cookies, and conduit preparation. Callers receive only the sanitized stream result.
 */
export interface ChatGptWebBrowserSession {
  url(): string;
  start(handlers: ChatGptWebBrowserSessionHandlers): Promise<() => Promise<void>>;
  submitPrompt(request: ChatGptWebBrowserSubmission): Promise<string | void>;
  readRenderedAssistantText?(timeoutMs?: number): Promise<string | null>;
}

export interface ChatGptWebBrowserSubmission {
  prompt: string;
  attachments: ChatGptWebResolvedAttachment[];
  signal?: AbortSignal | null;
}

export interface ChatGptWebBrowserTurnRequest {
  prompt: string;
  attachments?: ChatGptWebResolvedAttachment[];
  timeoutMs?: number;
  signal?: AbortSignal | null;
}

export interface ChatGptWebBrowserTurnResult {
  conversationId: string;
  turnExchangeId: string;
  text: string;
  status: string;
  endTurn: true;
}

export type { ChatGptWebUiSelection } from "./chatgptWebFirstParty.ts";

export interface PlaywrightChatGptWebBrowserSessionOptions {
  pageUrl?: string;
  selection?: ChatGptWebUiSelection;
  closePageOnCleanup?: boolean;
  executePageRequest?: (
    page: Page,
    input: ChatGptWebFirstPartyRequest,
    options?: { signal?: AbortSignal | null }
  ) => Promise<string>;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requirePrompt(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("ChatGPT Web browser turn requires a non-empty prompt");
  }
  return value;
}

function requireFirstPartyUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ChatGPT Web browser session requires a valid URL");
  }
  if (url.origin !== CHATGPT_WEB_ORIGIN) {
    throw new Error("ChatGPT Web browser session requires the first-party chatgpt.com origin");
  }
}

function maybeTerminalResult(
  snapshot: unknown,
  conversationId: string,
  turnExchangeId: string
): ChatGptWebBrowserTurnResult | null {
  if (!isRecord(snapshot) || !isRecord(snapshot.message)) return null;
  const message = snapshot.message;
  const author = isRecord(message.author) ? message.author : null;
  const content = isRecord(message.content) ? message.content : null;
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  if (
    author?.role !== "assistant" ||
    content?.content_type !== "text" ||
    !parts.every((part) => typeof part === "string") ||
    message.status !== "finished_successfully" ||
    message.end_turn !== true
  ) {
    return null;
  }
  return {
    conversationId,
    turnExchangeId,
    text: parts.join(""),
    status: message.status,
    endTurn: true,
  };
}

function snapshotMessageRole(snapshot: unknown): string | null {
  if (!isRecord(snapshot) || !isRecord(snapshot.message)) return null;
  const author = isRecord(snapshot.message.author) ? snapshot.message.author : null;
  return typeof author?.role === "string" ? author.role : null;
}

function terminalResult(
  snapshot: unknown,
  conversationId: string,
  turnExchangeId: string
): ChatGptWebBrowserTurnResult {
  const result = maybeTerminalResult(snapshot, conversationId, turnExchangeId);
  if (result) return result;
  if (!isRecord(snapshot) || !isRecord(snapshot.message)) {
    const rootKeys = isRecord(snapshot) ? Object.keys(snapshot).sort().join(",") : "non-object";
    throw new Error(`ChatGPT Web assistant document is incomplete (root=${rootKeys})`);
  }
  const message = snapshot.message;
  const author = isRecord(message.author) ? message.author : null;
  const content = isRecord(message.content) ? message.content : null;
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const summary = JSON.stringify({
    messageKeys: Object.keys(message).sort(),
    role: author?.role ?? null,
    contentType: content?.content_type ?? null,
    partCount: parts.length,
    partTypes: parts.map((part) => typeof part),
    status: message.status ?? null,
    endTurn: message.end_turn ?? null,
  });
  throw new Error(`ChatGPT Web assistant document is incomplete (${summary})`);
}

function encodeParsedEvent(event: ReturnType<typeof parseChatGptWebEncodedItem>[number]): string {
  const eventLine = event.event === "message" ? "" : `event: ${event.event}\n`;
  return `${eventLine}data: ${event.data}\n\n`;
}

/** Decode the direct first-party `/f/conversation` SSE body. */
export function parseChatGptWebDirectConversation(sseText: string): ChatGptWebBrowserTurnResult {
  if (typeof sseText !== "string" || !sseText.trim()) {
    throw new Error("ChatGPT Web direct conversation returned an empty stream");
  }
  let decoder = new ChatGptWebDeltaV1Decoder();
  let conversationId = "";
  let turnExchangeId = "";
  let latestTerminal: ChatGptWebBrowserTurnResult | null = null;
  for (const event of parseChatGptWebEncodedItem(sseText)) {
    if (isRecord(event.json)) {
      if (typeof event.json.conversation_id === "string") {
        conversationId = event.json.conversation_id;
      }
      if (typeof event.json.turn_exchange_id === "string") {
        turnExchangeId = event.json.turn_exchange_id;
      }
    }
    if (event.event === "delta_encoding") {
      latestTerminal =
        maybeTerminalResult(decoder.snapshot(), conversationId, turnExchangeId) ?? latestTerminal;
      decoder = new ChatGptWebDeltaV1Decoder();
    }
    decoder.ingest(encodeParsedEvent(event));
    latestTerminal =
      maybeTerminalResult(decoder.snapshot(), conversationId, turnExchangeId) ?? latestTerminal;
  }
  const result =
    maybeTerminalResult(decoder.snapshot(), conversationId, turnExchangeId) ?? latestTerminal;
  if (!result) return terminalResult(decoder.snapshot(), conversationId, turnExchangeId);
  return { ...result, conversationId, turnExchangeId };
}

/** Run one turn while the first-party browser remains the sole challenge and auth owner. */
export async function runChatGptWebBrowserTurn(
  session: ChatGptWebBrowserSession,
  request: ChatGptWebBrowserTurnRequest
): Promise<ChatGptWebBrowserTurnResult> {
  if (request.signal?.aborted) throw new Error("ChatGPT Web browser turn aborted");
  const prompt = requirePrompt(request.prompt);
  requireFirstPartyUrl(session.url());
  const timeoutMs = request.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("ChatGPT Web browser turn requires a positive timeout");
  }

  let decoder = new ChatGptWebDeltaV1Decoder();
  const bufferedFrames: string[] = [];
  let bufferedFrameBytes = 0;
  let topicStream: ChatGptWebTopicStream | null = null;
  let conversationId = "";
  let turnExchangeId = "";
  let latestTerminalAssistant: ChatGptWebBrowserTurnResult | null = null;
  let renderedReadPending = false;
  let settled = false;
  const turnController = new AbortController();
  let resolveResult: (result: ChatGptWebBrowserTurnResult) => void = () => {};
  let rejectResult: (error: Error) => void = () => {};

  const resultPromise = new Promise<ChatGptWebBrowserTurnResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // Browser events can finish while Playwright is still resolving the click promise. Attach a
  // rejection observer immediately, then return the same result promise below.
  void resultPromise.catch(() => {});
  const fail = (error: Error): void => {
    if (settled) return;
    settled = true;
    turnController.abort();
    rejectResult(error);
  };
  const complete = (): void => {
    if (settled) return;
    try {
      const result =
        latestTerminalAssistant ??
        terminalResult(decoder.snapshot(), conversationId, turnExchangeId);
      settled = true;
      resolveResult(result);
    } catch (error) {
      fail(error instanceof Error ? error : new Error("ChatGPT Web browser turn failed"));
    }
  };
  const tryCompleteFromRenderedAssistant = (): void => {
    if (renderedReadPending || !session.readRenderedAssistantText) return;
    renderedReadPending = true;
    void session
      .readRenderedAssistantText(10_000)
      .then((text) => {
        renderedReadPending = false;
        if (settled || typeof text !== "string" || !text.trim()) return;
        settled = true;
        resolveResult({
          conversationId,
          turnExchangeId,
          text: text.trim(),
          status: "finished_successfully",
          endTurn: true,
        });
      })
      .catch(() => {
        renderedReadPending = false;
      });
  };
  const ingestFrame = (frameText: string): void => {
    if (!topicStream || settled) return;
    try {
      const frame = topicStream.ingestFrame(frameText);
      for (const encodedItem of frame.encodedItems) {
        const decoded = decoder.ingest(encodedItem);
        if (!decoded.changed) continue;
        latestTerminalAssistant =
          maybeTerminalResult(decoder.snapshot(), conversationId, turnExchangeId) ??
          latestTerminalAssistant;
      }
      if (frame.done) {
        if (latestTerminalAssistant) {
          complete();
        } else if (snapshotMessageRole(decoder.snapshot()) === "tool") {
          topicStream = null;
          decoder = new ChatGptWebDeltaV1Decoder();
          tryCompleteFromRenderedAssistant();
        } else {
          complete();
        }
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error("ChatGPT Web stream decoding failed"));
    }
  };
  const handlers: ChatGptWebBrowserSessionHandlers = {
    onBootstrap(sseText) {
      if (settled) return;
      if (topicStream) {
        fail(new Error("ChatGPT Web browser turn received more than one handoff"));
        return;
      }
      try {
        const handoff = parseChatGptWebConversationHandoff(sseText);
        if (conversationId && handoff.conversationId !== conversationId) {
          fail(new Error("ChatGPT Web browser turn changed conversation during handoff"));
          return;
        }
        conversationId = handoff.conversationId;
        turnExchangeId = handoff.turnExchangeId;
        decoder = new ChatGptWebDeltaV1Decoder();
        latestTerminalAssistant = null;
        topicStream = new ChatGptWebTopicStream(handoff.topicId);
        for (const frame of bufferedFrames.splice(0)) ingestFrame(frame);
        bufferedFrameBytes = 0;
      } catch (error) {
        fail(error instanceof Error ? error : new Error("ChatGPT Web handoff parsing failed"));
      }
    },
    onWebSocketFrame(frameText) {
      if (settled) return;
      if (topicStream) {
        ingestFrame(frameText);
        return;
      }
      bufferedFrameBytes += Buffer.byteLength(frameText);
      if (
        bufferedFrames.length >= MAX_BUFFERED_FRAMES ||
        bufferedFrameBytes > MAX_BUFFERED_FRAME_BYTES
      ) {
        fail(new Error("ChatGPT Web browser turn exceeded the pre-handoff frame buffer"));
        return;
      }
      bufferedFrames.push(frameText);
    },
    onError() {
      fail(new Error("ChatGPT Web first-party browser session failed"));
    },
  };

  let cleanup: (() => Promise<void>) | null = null;
  const timeout = setTimeout(
    () => fail(new Error("ChatGPT Web browser turn timed out")),
    timeoutMs
  );
  timeout.unref?.();
  const abort = (): void => fail(new Error("ChatGPT Web browser turn aborted"));
  request.signal?.addEventListener("abort", abort, { once: true });

  try {
    cleanup = await session.start(handlers);
    void Promise.resolve()
      .then(async () => {
        if (settled) return;
        const directResponse = await session.submitPrompt({
          prompt,
          attachments: request.attachments ?? [],
          signal: turnController.signal,
        });
        if (typeof directResponse === "string" && !settled) {
          settled = true;
          resolveResult(parseChatGptWebDirectConversation(directResponse));
        }
      })
      .catch((error: unknown) => {
        fail(error instanceof Error ? error : new Error("ChatGPT Web prompt submission failed"));
      });
    return await resultPromise;
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", abort);
    await cleanup?.();
  }
}

/**
 * Playwright binding for a logged-in ChatGPT page.
 *
 * ChatGPT's own loaded module performs auth and Sentinel inside the page. The hot path never
 * touches the composer, model picker, attachment input, cookies, or bearer tokens.
 */
export class PlaywrightChatGptWebBrowserSession implements ChatGptWebBrowserSession {
  private readonly pageUrl: string;
  private readonly selection: ChatGptWebUiSelection | undefined;
  private readonly closePageOnCleanup: boolean;
  private readonly executePageRequest: NonNullable<
    PlaywrightChatGptWebBrowserSessionOptions["executePageRequest"]
  >;

  constructor(
    private readonly page: Page,
    options: string | PlaywrightChatGptWebBrowserSessionOptions = {}
  ) {
    if (typeof options === "string") {
      this.pageUrl = options;
      this.selection = undefined;
      this.closePageOnCleanup = false;
      this.executePageRequest = executeChatGptWebFirstPartyTurn;
    } else {
      this.pageUrl = options.pageUrl ?? "https://chatgpt.com/?temporary-chat=true";
      this.selection = options.selection;
      this.closePageOnCleanup = options.closePageOnCleanup === true;
      this.executePageRequest = options.executePageRequest ?? executeChatGptWebFirstPartyTurn;
    }
  }

  url(): string {
    return this.pageUrl;
  }

  async start(handlers: ChatGptWebBrowserSessionHandlers): Promise<() => Promise<void>> {
    void handlers;
    requireFirstPartyUrl(this.pageUrl);
    const cleanup = async (): Promise<void> => {
      if (this.closePageOnCleanup) await this.page.close().catch(() => {});
    };
    try {
      let currentIsFirstParty = false;
      try {
        currentIsFirstParty = new URL(this.page.url()).origin === CHATGPT_WEB_ORIGIN;
      } catch {
        currentIsFirstParty = false;
      }
      if (!currentIsFirstParty) {
        await this.page.goto(this.pageUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      }
      requireFirstPartyUrl(this.page.url());
      return cleanup;
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  async submitPrompt(request: ChatGptWebBrowserSubmission): Promise<string> {
    if (!this.selection) throw new Error("ChatGPT Web direct request requires a model selection");
    requireFirstPartyUrl(this.page.url());
    return this.executePageRequest(
      this.page,
      {
        prompt: requirePrompt(request.prompt),
        attachments: request.attachments,
        selection: this.selection,
      },
      { signal: request.signal }
    );
  }
}
