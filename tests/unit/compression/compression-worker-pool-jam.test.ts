import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { Worker } from "node:worker_threads";
import {
  closeCompressionWorkerPoolForTests,
  CompressionWorkerPool,
} from "../../../open-sse/services/compression/compressionWorkerPool.ts";
import {
  __resetCompressionFailOpenNotifierForTests,
  notifyCompressionFailOpen,
} from "../../../open-sse/services/compression/strategySelector.ts";
import { llmlinguaWorkerSpecifier } from "../../../open-sse/services/compression/engines/llmlingua/worker.ts";

/**
 * Regression guards for insoln/OmniRoute#2: a synchronous throw from spawn()
 * (e.g. Turbopack's moduleContext MODULE_NOT_FOUND in the standalone build)
 * must fail-open the queued jobs instead of stranding them in pool.queue
 * forever (unbounded main-isolate heap leak).
 */
const body = {
  model: "gpt-test",
  messages: [{ role: "user", content: "word ".repeat(600) }],
};

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms).unref()
    ),
  ]);
}

function throwingWorkerFactory(): () => Worker {
  return () => {
    const error = new Error("Cannot find module './compressionWorker.ts'");
    (error as NodeJS.ErrnoException).code = "MODULE_NOT_FOUND";
    throw error;
  };
}

after(async () => {
  await closeCompressionWorkerPoolForTests();
  __resetCompressionFailOpenNotifierForTests();
});

describe("CompressionWorkerPool spawn-failure queue drain", () => {
  it("fails open every queued job when spawn() throws synchronously", async () => {
    const pool = new CompressionWorkerPool({
      size: 2,
      workerFactory: throwingWorkerFactory(),
    });
    try {
      const jobs = [
        pool.run(body, "stacked"),
        pool.run(body, "stacked"),
        pool.run(body, "stacked"),
      ];
      const results = await withTimeout(Promise.all(jobs), 5000, "queued jobs never resolved");
      for (const result of results) {
        assert.deepEqual(result, { body, compressed: false, stats: null });
      }
    } finally {
      await pool.close();
    }
  });

  it("fails open immediately for jobs submitted after the pool broke", async () => {
    const pool = new CompressionWorkerPool({
      size: 1,
      workerFactory: throwingWorkerFactory(),
    });
    try {
      await withTimeout(pool.run(body, "stacked"), 5000, "first job never resolved");
      // A second wave must not hang waiting for a worker that can never spawn.
      const result = await withTimeout(pool.run(body, "stacked"), 5000, "post-break job hung");
      assert.deepEqual(result, { body, compressed: false, stats: null });
    } finally {
      await pool.close();
    }
  });

  it("keeps the queue drained: no job stays referenced after spawn failure", async () => {
    const pool = new CompressionWorkerPool({
      size: 1,
      workerFactory: throwingWorkerFactory(),
    });
    try {
      await withTimeout(pool.run(body, "stacked"), 5000, "job never resolved");
      // The internal queue must be empty — retained jobs hold the full request body.
      const queueLength = (pool as unknown as { queue: unknown[] }).queue.length;
      assert.equal(queueLength, 0);
    } finally {
      await pool.close();
    }
  });
});

describe("compression fail-open observability", () => {
  it("notifies (rate-limited) when the worker path fails open", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    try {
      notifyCompressionFailOpen();
      notifyCompressionFailOpen();
      notifyCompressionFailOpen();
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /fail-open|compression/i);
  });
});

describe("llmlingua worker spawn specifier", () => {
  it("passes a URL object (not a file:// string) to Worker — ERR_WORKER_PATH on Node >= 21", () => {
    const specifier = llmlinguaWorkerSpecifier("/app/onnxWorker.js");
    assert.ok(specifier instanceof URL, "Worker entry must be a URL object, not a string");
    assert.equal(specifier.protocol, "file:");
  });
});
