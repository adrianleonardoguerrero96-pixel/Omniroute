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
} from "../../../open-sse/services/compression/failOpenNotifier.ts";
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

/** Capture console.warn lines while the stub is installed. */
function captureWarn(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => {
    lines.push(String(message));
  };
  return {
    lines,
    restore() {
      console.warn = originalWarn;
    },
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
    const warn = captureWarn();
    try {
      notifyCompressionFailOpen();
      notifyCompressionFailOpen();
      notifyCompressionFailOpen();
    } finally {
      warn.restore();
    }
    assert.equal(warn.lines.length, 1);
    assert.match(warn.lines[0] ?? "", /fail-open|compression/i);
  });

  it("still logs a NEW distinct failure detail inside the rate-limit window", () => {
    const warn = captureWarn();
    try {
      notifyCompressionFailOpen("failure mode A");
      notifyCompressionFailOpen("failure mode A"); // suppressed
      notifyCompressionFailOpen("failure mode B"); // distinct detail — logged
    } finally {
      warn.restore();
    }
    assert.equal(warn.lines.length, 2);
    assert.match(warn.lines[1] ?? "", /failure mode B/);
  });

  it("notifies on the broken-pool short-circuit, not only at spawn time", async () => {
    const pool = new CompressionWorkerPool({
      size: 1,
      workerFactory: throwingWorkerFactory(),
    });
    const warn = captureWarn();
    try {
      await withTimeout(pool.run(body, "stacked"), 5000, "first job never resolved");
      // Same detail string → rate-limited away; reset the window so the
      // post-break run must exercise the notifyCompressionFailOpen call in run().
      __resetCompressionFailOpenNotifierForTests();
      const result = await withTimeout(pool.run(body, "stacked"), 5000, "post-break job hung");
      assert.deepEqual(result, { body, compressed: false, stats: null });
      assert.equal(warn.lines.length, 1, "broken-pool run must notify fail-open");
      assert.match(warn.lines[0] ?? "", /pool broken/);
    } finally {
      warn.restore();
      await pool.close();
    }
  });

  it("never calls the factory again once the pool is broken", async () => {
    let spawns = 0;
    const pool = new CompressionWorkerPool({
      size: 2,
      workerFactory: () => {
        spawns++;
        throw new Error("Cannot find module './compressionWorker.ts'");
      },
    });
    try {
      await withTimeout(pool.run(body, "stacked"), 5000, "first job never resolved");
      await withTimeout(pool.run(body, "stacked"), 5000, "post-break job hung");
      await withTimeout(pool.run(body, "stacked"), 5000, "third job hung");
      assert.equal(spawns, 1, "broken pool must not retry spawning");
    } finally {
      await pool.close();
    }
  });
});

describe("llmlingua worker spawn specifier", () => {
  it("passes a URL object (not a file:// string) to Worker — ERR_WORKER_PATH on Node >= 21", () => {
    const specifier = llmlinguaWorkerSpecifier("/app/onnxWorker.js");
    assert.ok(specifier instanceof URL, "Worker entry must be a URL object, not a string");
    assert.equal(specifier.protocol, "file:");
    assert.equal(specifier.pathname, "/app/onnxWorker.js");
  });
});
