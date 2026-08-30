import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  PlaywrightChatGptWebBrowserSession,
  runChatGptWebBrowserTurn,
  type ChatGptWebBrowserSession,
  type ChatGptWebBrowserSessionHandlers,
} from "../../open-sse/utils/chatgptWebBrowserSession.ts";

const HANDOFF_SSE =
  'data: {"type":"resume_conversation_token","kind":"topic",' +
  '"token":"resume-token","conversation_id":"conversation"}\n\n' +
  'data: {"type":"stream_handoff","conversation_id":"conversation",' +
  '"turn_exchange_id":"turn","options":[' +
  '{"type":"resume_sse_endpoint","topic_id":"topic"},' +
  '{"type":"subscribe_ws_topic","topic_id":"topic"}]}\n\n' +
  "data: [DONE]\n\n";

function streamItem(id: string, encodedItem: string, topicId = "topic"): string {
  return JSON.stringify([
    {
      type: "message",
      topic_id: topicId,
      payload: {
        type: "conversation-turn-stream",
        payload: {
          type: "stream-item",
          stream_item_id: id,
          parent_stream_item_id: null,
          encoded_item: encodedItem,
        },
      },
    },
  ]);
}

function doneFrame(topicId = "topic"): string {
  return JSON.stringify([
    {
      type: "message",
      topic_id: topicId,
      payload: {
        type: "conversation-turn-stream",
        payload: { type: "done" },
      },
    },
  ]);
}

class FakeBrowserSession implements ChatGptWebBrowserSession {
  handlers: ChatGptWebBrowserSessionHandlers | null = null;
  submittedPrompt = "";
  cleanupCount = 0;

  constructor(
    private readonly execute: (handlers: ChatGptWebBrowserSessionHandlers) => void,
    private readonly sessionUrl = "https://chatgpt.com/?temporary-chat=true",
    private readonly renderedAssistantText: string | null = null
  ) {}

  url(): string {
    return this.sessionUrl;
  }

  async start(handlers: ChatGptWebBrowserSessionHandlers): Promise<() => Promise<void>> {
    this.handlers = handlers;
    return async () => {
      this.cleanupCount += 1;
    };
  }

  async submitPrompt(prompt: string): Promise<void> {
    this.submittedPrompt = prompt;
    if (!this.handlers) throw new Error("session not started");
    this.execute(this.handlers);
  }

  async readRenderedAssistantText(): Promise<string | null> {
    return this.renderedAssistantText;
  }
}

describe("ChatGPT Web clean-room browser-owned session", () => {
  test("buffers WebSocket frames until handoff and returns only decoded output", async () => {
    const root =
      'event: delta_encoding\ndata: "v1"\n\n' +
      'event: delta\ndata: {"p":"","o":"add","v":{"message":{"author":{"role":"assistant"},' +
      '"content":{"content_type":"text","parts":[""]},"status":"in_progress",' +
      '"end_turn":false}}}\n\n';
    const append =
      'event: delta\ndata: {"p":"/message/content/parts/0","o":"append",' +
      '"v":"BROWSER_OWNED_OK"}\n\n';
    const finish =
      'event: delta\ndata: {"p":"/message/status","o":"replace",' +
      '"v":"finished_successfully"}\n\n' +
      'event: delta\ndata: {"p":"/message/end_turn","o":"replace","v":true}\n\n';

    const session = new FakeBrowserSession((handlers) => {
      handlers.onWebSocketFrame(streamItem("item-1", root));
      handlers.onBootstrap(HANDOFF_SSE);
      handlers.onWebSocketFrame(streamItem("item-2", append));
      handlers.onWebSocketFrame(streamItem("item-3", finish));
      handlers.onWebSocketFrame(doneFrame());
    });

    const result = await runChatGptWebBrowserTurn(session, {
      prompt: "clean-room prompt",
      timeoutMs: 1_000,
    });

    assert.equal(session.submittedPrompt, "clean-room prompt");
    assert.equal(session.cleanupCount, 1);
    assert.deepEqual(result, {
      conversationId: "conversation",
      turnExchangeId: "turn",
      text: "BROWSER_OWNED_OK",
      status: "finished_successfully",
      endTurn: true,
    });
    assert.equal(JSON.stringify(result).includes("resume-token"), false);
  });

  test("fails closed for non-ChatGPT origins before starting the browser session", async () => {
    const session = new FakeBrowserSession(() => {}, "https://example.com/");
    await assert.rejects(
      runChatGptWebBrowserTurn(session, { prompt: "blocked", timeoutMs: 50 }),
      /first-party chatgpt\.com origin/
    );
    assert.equal(session.handlers, null);
  });

  test("rejects incomplete terminal documents and always releases listeners", async () => {
    const session = new FakeBrowserSession((handlers) => {
      handlers.onBootstrap(HANDOFF_SSE);
      handlers.onWebSocketFrame(streamItem("item-1", "data: [DONE]\n\n"));
      handlers.onWebSocketFrame(doneFrame());
    });

    await assert.rejects(
      runChatGptWebBrowserTurn(session, { prompt: "incomplete", timeoutMs: 1_000 }),
      /assistant document is incomplete/
    );
    assert.equal(session.cleanupCount, 1);
  });

  test("preserves the terminal assistant when a hidden tool document follows it", async () => {
    const assistant =
      'event: delta_encoding\ndata: "v1"\n\n' +
      'event: delta\ndata: {"p":"","o":"add","v":{"message":{' +
      '"author":{"role":"assistant"},"content":{"content_type":"text",' +
      '"parts":["VISIBLE_ASSISTANT"]},"status":"finished_successfully",' +
      '"end_turn":true}}}\n\n' +
      "data: [DONE]\n\n";
    const hiddenTool =
      'event: delta_encoding\ndata: "v1"\n\n' +
      'event: delta\ndata: {"p":"","o":"add","v":{"message":{' +
      '"author":{"role":"tool"},"content":{"content_type":"text",' +
      '"parts":["hidden"]},"status":"in_progress","end_turn":null}}}\n\n' +
      "data: [DONE]\n\n";
    const session = new FakeBrowserSession((handlers) => {
      handlers.onBootstrap(HANDOFF_SSE);
      handlers.onWebSocketFrame(streamItem("assistant", assistant));
      handlers.onWebSocketFrame(streamItem("tool", hiddenTool));
      handlers.onWebSocketFrame(doneFrame());
    });

    const result = await runChatGptWebBrowserTurn(session, {
      prompt: "multi-document",
      timeoutMs: 1_000,
    });

    assert.equal(result.text, "VISIBLE_ASSISTANT");
    assert.equal(session.cleanupCount, 1);
  });

  test("continues through a tool-only topic into the next same-conversation handoff", async () => {
    const tool =
      'event: delta_encoding\ndata: "v1"\n\n' +
      'event: delta\ndata: {"p":"","o":"add","v":{"message":{' +
      '"author":{"role":"tool"},"content":{"content_type":"text",' +
      '"parts":["hidden"]},"status":"in_progress","end_turn":null}}}\n\n' +
      "data: [DONE]\n\n";
    const assistant =
      'event: delta_encoding\ndata: "v1"\n\n' +
      'event: delta\ndata: {"p":"","o":"add","v":{"message":{' +
      '"author":{"role":"assistant"},"content":{"content_type":"text",' +
      '"parts":["MULTI_HANDOFF_OK"]},"status":"finished_successfully",' +
      '"end_turn":true}}}\n\n' +
      "data: [DONE]\n\n";
    const secondHandoff = HANDOFF_SSE.replaceAll('"turn"', '"turn-2"').replaceAll(
      '"topic"',
      '"topic-2"'
    );
    const session = new FakeBrowserSession((handlers) => {
      handlers.onBootstrap(HANDOFF_SSE);
      handlers.onWebSocketFrame(streamItem("tool", tool));
      handlers.onWebSocketFrame(doneFrame());
      handlers.onBootstrap(secondHandoff);
      handlers.onWebSocketFrame(streamItem("assistant", assistant, "topic-2"));
      handlers.onWebSocketFrame(doneFrame("topic-2"));
    });

    const result = await runChatGptWebBrowserTurn(session, {
      prompt: "multi-handoff",
      timeoutMs: 1_000,
    });

    assert.equal(result.text, "MULTI_HANDOFF_OK");
    assert.equal(result.conversationId, "conversation");
    assert.equal(result.turnExchangeId, "turn-2");
    assert.equal(session.cleanupCount, 1);
  });

  test("uses the first-party rendered assistant after a tool-only terminal topic", async () => {
    const tool =
      'event: delta_encoding\ndata: "v1"\n\n' +
      'event: delta\ndata: {"p":"","o":"add","v":{"message":{' +
      '"author":{"role":"tool"},"content":{"content_type":"text",' +
      '"parts":["hidden"]},"status":"in_progress","end_turn":null}}}\n\n' +
      "data: [DONE]\n\n";
    const session = new FakeBrowserSession(
      (handlers) => {
        handlers.onBootstrap(HANDOFF_SSE);
        handlers.onWebSocketFrame(streamItem("tool", tool));
        handlers.onWebSocketFrame(doneFrame());
      },
      "https://chatgpt.com/?temporary-chat=true",
      "DOM_FALLBACK_OK"
    );

    const result = await runChatGptWebBrowserTurn(session, {
      prompt: "rendered fallback",
      timeoutMs: 50,
    });

    assert.equal(result.text, "DOM_FALLBACK_OK");
    assert.equal(result.status, "finished_successfully");
    assert.equal(session.cleanupCount, 1);
  });

  test("aborts without dispatch when the caller signal is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const session = new FakeBrowserSession(() => {});

    await assert.rejects(
      runChatGptWebBrowserTurn(session, {
        prompt: "cancelled",
        timeoutMs: 1_000,
        signal: controller.signal,
      }),
      /aborted/
    );
    assert.equal(session.handlers, null);
    assert.equal(session.submittedPrompt, "");
  });

  test("aborts promptly while browser submission is still pending", async () => {
    const controller = new AbortController();
    let cleanupCount = 0;
    let releaseSubmission: () => void = () => {};
    const session = {
      url: () => "https://chatgpt.com/?temporary-chat=true",
      start: async () => async () => {
        cleanupCount += 1;
      },
      submitPrompt: async () =>
        new Promise<void>((resolve) => {
          releaseSubmission = resolve;
        }),
    } satisfies ChatGptWebBrowserSession;

    const turn = runChatGptWebBrowserTurn(session, {
      prompt: "cancel pending submit",
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();

    const timeoutMarker = Symbol("abort-timeout");
    let timeout: NodeJS.Timeout | undefined;
    const observed = await Promise.race([
      turn.catch((error: unknown) => error),
      new Promise<typeof timeoutMarker>((resolve) => {
        timeout = setTimeout(() => resolve(timeoutMarker), 200);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    releaseSubmission();
    if (observed === timeoutMarker) await turn.catch(() => {});

    assert.notEqual(observed, timeoutMarker, "abort waited for the pending browser submission");
    assert.match(String(observed), /aborted/);
    assert.equal(cleanupCount, 1);
  });

  test("Playwright binding attaches before navigation and removes every listener", async () => {
    type Listener = (...args: unknown[]) => void;
    const pageListeners = new Map<string, Set<Listener>>();
    const socketListeners = new Map<string, Set<Listener>>();
    const calls: string[] = [];
    const locator = (selector: string) => ({
      async waitFor() {
        calls.push(`wait:${selector}`);
      },
      async count() {
        return 0;
      },
      async fill(value: string) {
        calls.push(`fill:${selector}:${value}`);
      },
      async click() {
        calls.push(`click:${selector}`);
      },
    });
    const page = {
      url: () => "https://chatgpt.com/?temporary-chat=true",
      on(event: string, listener: Listener) {
        const listeners = pageListeners.get(event) ?? new Set<Listener>();
        listeners.add(listener);
        pageListeners.set(event, listeners);
      },
      off(event: string, listener: Listener) {
        pageListeners.get(event)?.delete(listener);
      },
      async goto() {
        calls.push("goto");
      },
      locator,
    } as unknown as import("playwright").Page;
    const socket = {
      url: () => "wss://ws.chatgpt.com/socket.io/",
      on(event: string, listener: Listener) {
        const listeners = socketListeners.get(event) ?? new Set<Listener>();
        listeners.add(listener);
        socketListeners.set(event, listeners);
      },
      off(event: string, listener: Listener) {
        socketListeners.get(event)?.delete(listener);
      },
    };
    const observed = { bootstraps: [] as string[], frames: [] as string[], errors: 0 };
    const session = new PlaywrightChatGptWebBrowserSession(page);
    const cleanup = await session.start({
      onBootstrap: (body) => observed.bootstraps.push(body),
      onWebSocketFrame: (frame) => observed.frames.push(frame),
      onError: () => {
        observed.errors += 1;
      },
    });

    assert.equal(calls[0], "goto");
    for (const listener of pageListeners.get("websocket") ?? []) listener(socket);
    for (const listener of socketListeners.get("framereceived") ?? []) {
      listener({ payload: "frame" });
    }
    for (const listener of pageListeners.get("response") ?? []) {
      listener({
        url: () => "https://chatgpt.com/backend-api/f/conversation",
        request: () => ({ method: () => "POST" }),
        text: async () => HANDOFF_SSE,
      });
    }
    await Promise.resolve();
    await session.submitPrompt("selector test");

    assert.deepEqual(observed, { bootstraps: [HANDOFF_SSE], frames: ["frame"], errors: 0 });
    assert.deepEqual(calls.slice(1), [
      "wait:#prompt-textarea",
      "fill:#prompt-textarea:selector test",
      'wait:[data-testid="send-button"]',
      'click:[data-testid="send-button"]',
    ]);

    await cleanup();
    assert.equal(pageListeners.get("response")?.size, 0);
    assert.equal(pageListeners.get("websocket")?.size, 0);
    assert.equal(socketListeners.get("framereceived")?.size, 0);
  });

  test("Playwright binding reports an unexpected page termination and removes lifecycle listeners", async () => {
    type Listener = (...args: unknown[]) => void;
    const pageListeners = new Map<string, Set<Listener>>();
    const page = {
      url: () => "https://chatgpt.com/?temporary-chat=true",
      on(event: string, listener: Listener) {
        const listeners = pageListeners.get(event) ?? new Set<Listener>();
        listeners.add(listener);
        pageListeners.set(event, listeners);
      },
      off(event: string, listener: Listener) {
        pageListeners.get(event)?.delete(listener);
      },
      async goto() {},
    } as unknown as import("playwright").Page;
    let errors = 0;
    const session = new PlaywrightChatGptWebBrowserSession(page);
    const cleanup = await session.start({
      onBootstrap: () => {},
      onWebSocketFrame: () => {},
      onError: () => {
        errors += 1;
      },
    });

    for (const listener of pageListeners.get("crash") ?? []) listener();
    assert.equal(errors, 1);

    await cleanup();
    assert.equal(pageListeners.get("crash")?.size, 0);
    assert.equal(pageListeners.get("close")?.size, 0);
  });

  test("Playwright binding ignores a stale rendered assistant from before submission", async () => {
    const calls: string[] = [];
    const composer = {
      async waitFor() {},
      async fill() {},
    };
    const sendButton = {
      async waitFor() {},
      async click() {},
    };
    const assistant = {
      async count() {
        calls.push("count:assistant");
        return 2;
      },
      last() {
        return {
          async waitFor() {},
          async innerText() {
            calls.push("read:stale");
            return "STALE_ASSISTANT";
          },
        };
      },
      nth(index: number) {
        return {
          async waitFor() {
            calls.push(`wait:fresh:${index}`);
          },
          async innerText() {
            calls.push(`read:fresh:${index}`);
            return "FRESH_ASSISTANT";
          },
        };
      },
    };
    const page = {
      locator(selector: string) {
        if (selector === "#prompt-textarea") return composer;
        if (selector === '[data-testid="send-button"]') return sendButton;
        if (selector === '[data-message-author-role="assistant"]') return assistant;
        throw new Error(`Unexpected selector: ${selector}`);
      },
    } as unknown as import("playwright").Page;
    const session = new PlaywrightChatGptWebBrowserSession(page);

    await session.submitPrompt("fresh answer only");
    const rendered = await session.readRenderedAssistantText(100);

    assert.equal(rendered, "FRESH_ASSISTANT");
    assert.deepEqual(calls, ["count:assistant", "wait:fresh:2", "read:fresh:2"]);
  });

  test("Playwright binding selects the observed model and slider index before submit", async () => {
    const calls: string[] = [];
    const action = (name: string, checked = false) => ({
      async waitFor() {
        calls.push(`wait:${name}`);
      },
      async count() {
        return 0;
      },
      async click() {
        calls.push(`click:${name}`);
      },
      async fill(value: string) {
        calls.push(`fill:${name}:${value}`);
      },
      async press(key: string) {
        calls.push(`press:${name}:${key}`);
      },
      async getAttribute(attribute: string) {
        calls.push(`attribute:${name}:${attribute}`);
        return attribute === "aria-checked" && checked ? "true" : null;
      },
      first() {
        return action(`${name}:first`);
      },
      last() {
        return action(`${name}:last`);
      },
      locator(selector: string) {
        return action(`${name}>${selector}`);
      },
    });
    const page = {
      locator: (selector: string) => action(selector),
      getByRole: (role: string, options: { name: string }) =>
        action(`${role}:${options.name}`, false),
      keyboard: { press: async (key: string) => calls.push(`keyboard:${key}`) },
    } as unknown as import("playwright").Page;
    const session = new PlaywrightChatGptWebBrowserSession(page, {
      selection: { modelLabel: "GPT-5.5", effortIndex: 3 },
    });

    await session.submitPrompt("selected prompt");

    assert.deepEqual(calls, [
      'wait:form:has(#prompt-textarea) button[aria-haspopup="menu"]:not([data-testid="composer-plus-btn"]):last',
      'click:form:has(#prompt-textarea) button[aria-haspopup="menu"]:not([data-testid="composer-plus-btn"]):last',
      'click:[role="menu"]:last>[role="menuitem"]:first',
      "attribute:menuitemradio:GPT-5.5:aria-checked",
      "click:menuitemradio:GPT-5.5",
      'press:[role="menu"] [role="slider"]:last:Home',
      'press:[role="menu"] [role="slider"]:last:ArrowRight',
      'press:[role="menu"] [role="slider"]:last:ArrowRight',
      'press:[role="menu"] [role="slider"]:last:ArrowRight',
      "keyboard:Escape",
      "wait:#prompt-textarea",
      "fill:#prompt-textarea:selected prompt",
      'wait:[data-testid="send-button"]',
      'click:[data-testid="send-button"]',
    ]);
  });

  test("Playwright binding skips a redundant click on the selected model", async () => {
    const calls: string[] = [];
    const action = (name: string, checked = false) => ({
      async waitFor() {
        calls.push(`wait:${name}`);
      },
      async count() {
        return 0;
      },
      async click() {
        calls.push(`click:${name}`);
      },
      async fill(value: string) {
        calls.push(`fill:${name}:${value}`);
      },
      async press(key: string) {
        calls.push(`press:${name}:${key}`);
      },
      async getAttribute(attribute: string) {
        calls.push(`attribute:${name}:${attribute}`);
        return attribute === "aria-checked" && checked ? "true" : null;
      },
      first() {
        return action(`${name}:first`);
      },
      last() {
        return action(`${name}:last`);
      },
      locator(selector: string) {
        return action(`${name}>${selector}`);
      },
    });
    const page = {
      locator: (selector: string) => action(selector),
      getByRole: (role: string, options: { name: string }) =>
        action(`${role}:${options.name}`, true),
      keyboard: { press: async (key: string) => calls.push(`keyboard:${key}`) },
    } as unknown as import("playwright").Page;
    const session = new PlaywrightChatGptWebBrowserSession(page, {
      selection: { modelLabel: "GPT-5.6 Sol", effortIndex: 0 },
    });

    await session.submitPrompt("same model");

    assert.equal(calls.includes("click:menuitemradio:GPT-5.6 Sol"), false);
    assert.equal(
      calls.filter(
        (call) =>
          call ===
          'click:form:has(#prompt-textarea) button[aria-haspopup="menu"]:not([data-testid="composer-plus-btn"]):last'
      ).length,
      1
    );
    assert.equal(calls.includes("keyboard:Escape"), true);
    assert.equal(calls.includes('press:[role="menu"] [role="slider"]:last:Home'), true);
  });
});
