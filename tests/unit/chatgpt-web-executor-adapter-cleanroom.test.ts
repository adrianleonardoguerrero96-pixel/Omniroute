import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildChatGptWebOpenAiResponse,
  executeChatGptWebCleanRoom,
  normalizeChatGptWebStorageState,
  prepareChatGptWebBrowserRequest,
} from "../../open-sse/utils/chatgptWebExecutorAdapter.ts";
import type { ChatGptWebBrowserSession } from "../../open-sse/utils/chatgptWebBrowserSession.ts";

describe("ChatGPT Web clean-room executor request adapter", () => {
  test("maps observed 5.6 modes without treating Pro as max effort", () => {
    assert.deepEqual(
      prepareChatGptWebBrowserRequest("gpt-5-6-thinking", {
        messages: [{ role: "user", content: "hello" }],
        reasoning_effort: "max",
      }),
      {
        prompt: "hello",
        selection: { modelLabel: "GPT-5.6 Sol", effortIndex: 3 },
      }
    );
    assert.deepEqual(
      prepareChatGptWebBrowserRequest("gpt-5-6-pro", {
        messages: [{ role: "user", content: "hello" }],
      }).selection,
      { modelLabel: "GPT-5.6 Sol", effortIndex: 4 }
    );
    assert.deepEqual(
      prepareChatGptWebBrowserRequest("gpt-5-6-instant", {
        messages: [{ role: "user", content: "hello" }],
      }).selection,
      { modelLabel: "GPT-5.6 Sol", effortIndex: 0 }
    );
    assert.deepEqual(
      prepareChatGptWebBrowserRequest("gpt-5-6", {
        messages: [{ role: "user", content: "hello" }],
      }).selection,
      { modelLabel: "GPT-5.6 Sol", effortIndex: 0 }
    );
  });

  test("maps every observed GPT-5.5 route including its distinct Pro model", () => {
    assert.deepEqual(
      prepareChatGptWebBrowserRequest("gpt-5-5-instant", {
        messages: [{ role: "user", content: "hello" }],
      }).selection,
      { modelLabel: "GPT-5.5", effortIndex: 0 }
    );
    assert.deepEqual(
      prepareChatGptWebBrowserRequest("gpt-5-5-thinking", {
        messages: [{ role: "user", content: "hello" }],
        reasoning_effort: "max",
      }).selection,
      { modelLabel: "GPT-5.5", effortIndex: 3 }
    );
    assert.deepEqual(
      prepareChatGptWebBrowserRequest("gpt-5-5-pro", {
        messages: [{ role: "user", content: "hello" }],
      }).selection,
      { modelLabel: "GPT-5.5", effortIndex: 4 }
    );
  });

  test("maps reasoning effort monotonically and preserves multi-message roles", () => {
    const expected = [
      ["low", 0],
      ["medium", 1],
      ["high", 2],
      ["xhigh", 3],
      ["max", 3],
    ] as const;
    for (const [effort, effortIndex] of expected) {
      assert.equal(
        prepareChatGptWebBrowserRequest("gpt-5.5", {
          reasoning_effort: effort,
          messages: [
            { role: "system", content: "Be concise." },
            { role: "user", content: [{ type: "text", text: "Question" }] },
          ],
        }).selection.effortIndex,
        effortIndex
      );
    }

    const prepared = prepareChatGptWebBrowserRequest("gpt-5.5", {
      reasoning_effort: "high",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Question" },
      ],
    });
    assert.equal(prepared.selection.modelLabel, "GPT-5.5");
    assert.equal(prepared.prompt, "System:\nBe concise.\n\nUser:\nQuestion");
  });

  test("rejects unknown models, tool turns, and non-text content", () => {
    assert.throws(
      () =>
        prepareChatGptWebBrowserRequest("unknown", {
          messages: [{ role: "user", content: "hello" }],
        }),
      /unsupported model/
    );
    assert.throws(
      () =>
        prepareChatGptWebBrowserRequest("gpt-5.5", {
          tools: [{ type: "function", function: { name: "tool" } }],
          messages: [{ role: "user", content: "hello" }],
        }),
      /does not support tools/
    );
    assert.throws(
      () =>
        prepareChatGptWebBrowserRequest("gpt-5.5", {
          messages: [{ role: "user", content: [{ type: "image_url", image_url: "x" }] }],
        }),
      /text content only/
    );
  });
});

describe("ChatGPT Web clean-room storage state", () => {
  test("accepts only first-party cookie/origin state and returns a detached copy", () => {
    const source = {
      cookies: [
        {
          name: "session",
          value: "secret",
          domain: ".chatgpt.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ],
      origins: [{ origin: "https://chatgpt.com", localStorage: [] }],
    };
    const normalized = normalizeChatGptWebStorageState(source);
    assert.deepEqual(normalized, source);
    assert.notEqual(normalized, source);
    source.cookies[0].value = "changed";
    assert.equal(normalized.cookies[0].value, "secret");
  });

  test("rejects foreign cookie domains and malformed state", () => {
    assert.throws(
      () =>
        normalizeChatGptWebStorageState({
          cookies: [
            {
              name: "x",
              value: "y",
              domain: ".example.com",
              path: "/",
              expires: -1,
              httpOnly: true,
              secure: true,
              sameSite: "Lax",
            },
          ],
          origins: [],
        }),
      /foreign cookie domain/
    );
    assert.throws(() => normalizeChatGptWebStorageState({ cookies: [] }), /invalid/);
  });
});

describe("ChatGPT Web clean-room executor response adapter", () => {
  const turn = {
    conversationId: "conversation",
    turnExchangeId: "turn",
    text: "answer",
    status: "finished_successfully",
    endTurn: true as const,
  };

  test("builds OpenAI JSON and terminal SSE without leaking transport identity", async () => {
    const jsonResponse = buildChatGptWebOpenAiResponse("gpt-5-6-thinking", turn, false, {
      id: "chatcmpl-cleanroom",
      created: 123,
    });
    const json = (await jsonResponse.json()) as Record<string, unknown>;
    assert.equal(json.object, "chat.completion");
    assert.equal(JSON.stringify(json).includes("conversation"), false);
    assert.equal(JSON.stringify(json).includes("turn"), false);

    const streamResponse = buildChatGptWebOpenAiResponse("gpt-5-6-thinking", turn, true, {
      id: "chatcmpl-cleanroom",
      created: 123,
    });
    const stream = await streamResponse.text();
    assert.match(stream, /"role":"assistant"/);
    assert.match(stream, /"content":"answer"/);
    assert.match(stream, /"finish_reason":"stop"/);
    assert.ok(stream.endsWith("data: [DONE]\n\n"));
  });

  test("executes through an injected browser session factory", async () => {
    const session = {
      url: () => "https://chatgpt.com/?temporary-chat=true",
      start: async () => async () => {},
      submitPrompt: async () => {},
    } satisfies ChatGptWebBrowserSession;
    let observed: Record<string, unknown> | null = null;
    const response = await executeChatGptWebCleanRoom(
      {
        model: "gpt-5-6-pro",
        body: { messages: [{ role: "user", content: "hello" }] },
        stream: false,
        credentials: {
          connectionId: "connection",
          providerSpecificData: {
            storageState: { cookies: [], origins: [] },
            customUserAgent: "CleanRoomBrowser/1.0",
          },
        },
      },
      {
        createSession: async (input) => {
          observed = input;
          return session;
        },
        runTurn: async (_session, request) => {
          assert.equal(request.prompt, "hello");
          return turn;
        },
        id: () => "chatcmpl-cleanroom",
        now: () => 123_000,
      }
    );

    assert.deepEqual(observed?.selection, { modelLabel: "GPT-5.6 Sol", effortIndex: 4 });
    assert.deepEqual(observed?.storageState, { cookies: [], origins: [] });
    assert.equal(observed?.userAgent, "CleanRoomBrowser/1.0");
    assert.equal(response.status, 200);
  });
});
