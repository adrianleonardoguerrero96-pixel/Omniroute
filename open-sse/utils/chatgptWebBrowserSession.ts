import { Buffer } from "node:buffer";

import { ChatGptWebDeltaV1Decoder } from "./chatgptWebDeltaV1.ts";
import {
  ChatGptWebTopicStream,
  parseChatGptWebConversationHandoff,
} from "./chatgptWebTransport.ts";

type JsonRecord = Record<string, unknown>;
type Page = import("playwright").Page;
type PlaywrightResponse = import("playwright").Response;
type PlaywrightWebSocket = import("playwright").WebSocket;

const CHATGPT_WEB_ORIGIN = "https://chatgpt.com";
const CHATGPT_WEB_CONVERSATION_PATH = "/backend-api/f/conversation";
const CHATGPT_WEB_SOCKET_ORIGIN = "wss://ws.chatgpt.com";
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
  submitPrompt(prompt: string): Promise<void>;
  readRenderedAssistantText?(timeoutMs?: number): Promise<string | null>;
}

export interface ChatGptWebBrowserTurnRequest {
  prompt: string;
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

export type ChatGptWebUiSelection =
  | {
      kind: "picker";
      modelLabel: "GPT-5.6 Sol" | "GPT-5.5";
      effortIndex: 0 | 1 | 2 | 3 | 4;
    }
  | {
      kind: "free";
      thinkEnabled: boolean;
    };

export interface PlaywrightChatGptWebBrowserSessionOptions {
  pageUrl?: string;
  selection?: ChatGptWebUiSelection;
  closePageOnCleanup?: boolean;
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
    // Browser submission can remain pending inside Playwright while the caller aborts or the
    // response stream finishes. Do not make turn settlement wait for that browser-side promise;
    // cleanup closes the page and the rejection observer below consumes the resulting error.
    void Promise.resolve()
      .then(async () => {
        if (settled) return;
        await session.submitPrompt(prompt);
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

function isConversationResponse(response: PlaywrightResponse): boolean {
  if (response.request().method() !== "POST") return false;
  try {
    const url = new URL(response.url());
    return url.origin === CHATGPT_WEB_ORIGIN && url.pathname === CHATGPT_WEB_CONVERSATION_PATH;
  } catch {
    return false;
  }
}

function isChatGptWebSocket(socket: PlaywrightWebSocket): boolean {
  try {
    return new URL(socket.url()).origin === CHATGPT_WEB_SOCKET_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * Playwright binding for a logged-in ChatGPT page.
 *
 * It deliberately drives the visible first-party composer. It never reads cookies, authorization
 * headers, Sentinel answers, or conduit tokens into Node.js.
 */
export class PlaywrightChatGptWebBrowserSession implements ChatGptWebBrowserSession {
  private readonly pageUrl: string;
  private readonly selection: ChatGptWebUiSelection | undefined;
  private readonly closePageOnCleanup: boolean;
  private assistantCountBeforeSubmit: number | null = null;

  constructor(
    private readonly page: Page,
    options: string | PlaywrightChatGptWebBrowserSessionOptions = {}
  ) {
    if (typeof options === "string") {
      this.pageUrl = options;
      this.selection = undefined;
      this.closePageOnCleanup = false;
    } else {
      this.pageUrl = options.pageUrl ?? "https://chatgpt.com/?temporary-chat=true";
      this.selection = options.selection;
      this.closePageOnCleanup = options.closePageOnCleanup === true;
    }
  }

  url(): string {
    return this.pageUrl;
  }

  async start(handlers: ChatGptWebBrowserSessionHandlers): Promise<() => Promise<void>> {
    requireFirstPartyUrl(this.pageUrl);
    let pageTerminated = false;
    const socketListeners = new Map<
      PlaywrightWebSocket,
      (data: { payload: string | Buffer }) => void
    >();
    const onPageTerminated = (): void => {
      if (pageTerminated) return;
      pageTerminated = true;
      handlers.onError(new Error("ChatGPT Web first-party browser page terminated"));
    };
    const onResponse = (response: PlaywrightResponse): void => {
      if (!isConversationResponse(response)) return;
      void response
        .text()
        .then((body) => handlers.onBootstrap(body))
        .catch(() => handlers.onError(new Error("ChatGPT Web bootstrap response was unreadable")));
    };
    const onWebSocket = (socket: PlaywrightWebSocket): void => {
      if (!isChatGptWebSocket(socket)) return;
      const onFrame = ({ payload }: { payload: string | Buffer }): void => {
        handlers.onWebSocketFrame(typeof payload === "string" ? payload : payload.toString("utf8"));
      };
      socketListeners.set(socket, onFrame);
      socket.on("framereceived", onFrame);
    };
    const cleanup = async (): Promise<void> => {
      this.page.off("response", onResponse);
      this.page.off("websocket", onWebSocket);
      this.page.off("crash", onPageTerminated);
      this.page.off("close", onPageTerminated);
      for (const [socket, listener] of socketListeners) socket.off("framereceived", listener);
      socketListeners.clear();
      if (this.closePageOnCleanup) await this.page.close().catch(() => {});
    };

    this.page.on("response", onResponse);
    this.page.on("websocket", onWebSocket);
    this.page.on("crash", onPageTerminated);
    this.page.on("close", onPageTerminated);
    try {
      await this.page.goto(this.pageUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      requireFirstPartyUrl(this.page.url());
      return cleanup;
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  private async applySelection(): Promise<void> {
    if (!this.selection) return;
    if (this.selection.kind === "free") {
      // Free accounts expose no model picker or effort slider. The first-party UI routes
      // ordinary Luna turns with Think off and reasoning turns with the same toggle on.
      const thinkButton = this.page.getByRole("button", { name: "Think", exact: true });
      await thinkButton.waitFor({ state: "visible", timeout: 30_000 });
      const thinkEnabled = (await thinkButton.getAttribute("aria-pressed")) === "true";
      if (thinkEnabled !== this.selection.thinkEnabled) await thinkButton.click();
      return;
    }
    const toggle = this.page
      .locator(
        'form:has(#prompt-textarea) button[aria-haspopup="menu"]' +
          ':not([data-testid="composer-plus-btn"])'
      )
      .last();
    await toggle.waitFor({ state: "visible", timeout: 30_000 });
    await toggle.click();

    const menu = this.page.locator('[role="menu"]').last();
    const modelControl = menu.locator('[role="menuitem"]').first();
    await modelControl.click();
    const modelOption = this.page.getByRole("menuitemradio", {
      name: this.selection.modelLabel,
      exact: true,
    });
    const modelAlreadySelected = (await modelOption.getAttribute("aria-checked")) === "true";
    if (!modelAlreadySelected) {
      await modelOption.click();
    } else {
      // The selected option remains inside the model submenu. Return to the already-open
      // reasoning menu; selecting a different model performs this transition automatically.
      await this.page.keyboard.press("Escape");
    }

    const slider = this.page.locator('[role="menu"] [role="slider"]').last();
    await slider.press("Home");
    for (let index = 0; index < this.selection.effortIndex; index += 1) {
      await slider.press("ArrowRight");
    }
    await this.page.keyboard.press("Escape");
  }

  async submitPrompt(prompt: string): Promise<void> {
    await this.applySelection();
    const composer = this.page.locator("#prompt-textarea");
    await composer.waitFor({ state: "visible", timeout: 30_000 });
    await composer.fill(requirePrompt(prompt));
    this.assistantCountBeforeSubmit = await this.page
      .locator('[data-message-author-role="assistant"]')
      .count();
    const sendButton = this.page.locator('[data-testid="send-button"]');
    await sendButton.waitFor({ state: "visible", timeout: 30_000 });
    await sendButton.click();
  }

  async readRenderedAssistantText(timeoutMs = 10_000): Promise<string | null> {
    const assistants = this.page.locator('[data-message-author-role="assistant"]');
    const assistant =
      this.assistantCountBeforeSubmit === null
        ? assistants.last()
        : assistants.nth(this.assistantCountBeforeSubmit);
    await assistant.waitFor({ state: "visible", timeout: timeoutMs });
    const text = (await assistant.innerText()).trim();
    return text || null;
  }
}
