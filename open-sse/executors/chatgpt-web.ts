import { chatgpt_webProvider } from "../config/providers/registry/chatgpt-web/index.ts";
import {
  executeChatGptWebCleanRoom,
  type ChatGptWebExecutorAdapterDeps,
} from "../utils/chatgptWebExecutorAdapter.ts";
import { makeExecutorErrorResult, sanitizeErrorMessage } from "../utils/error.ts";
import { BaseExecutor, type ExecuteInput } from "./base.ts";

const CHATGPT_WEB_URL = "https://chatgpt.com";

function statusForAdapterError(message: string): number {
  if (/storage state|credentials|connection ID/i.test(message)) return 401;
  if (/request|messages|prompt|model|tools|text content|reasoning effort/i.test(message))
    return 400;
  return 502;
}

/** Common ChatGPT Web executor rebuilt solely from first-party UI/network observations. */
export class ChatGptWebExecutor extends BaseExecutor {
  constructor(private readonly deps: ChatGptWebExecutorAdapterDeps = {}) {
    super("chatgpt-web", {
      id: chatgpt_webProvider.id,
      baseUrl: chatgpt_webProvider.baseUrl,
    });
  }

  async execute(input: ExecuteInput) {
    try {
      return await executeChatGptWebCleanRoom(input, this.deps);
    } catch (error) {
      const message = sanitizeErrorMessage(error);
      return makeExecutorErrorResult(
        statusForAdapterError(message),
        message || "ChatGPT Web browser execution failed",
        input.body,
        CHATGPT_WEB_URL
      );
    }
  }
}

export default ChatGptWebExecutor;
