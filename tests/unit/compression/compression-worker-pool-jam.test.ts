import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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

/**
 * EventEmitter-based Worker stand-in: mirrors node:worker_threads' surface
 * (on/once/off, postMessage, terminate). Construction is observable so a
 * factory can busy the first worker(s), then start throwing.
 */
type FakeWorker = Worker & { messages: unknown[] };

function fakeWorker(): FakeWorker {
  const worker = new EventEmitter() as FakeWorker;
  worker.messages = [];
  worker.postMessage = ((message: unknown) => {
    worker.messages.push(message);
  }) as Worker["postMessage"];
  worker.terminate = (() => Promise.resolve(0)) as Worker["terminate"];
  return worker;
}

function workerFactoryThatThrowsAfter(first: FakeWorker): {
  factory: () => Worker;
  spawns: () => number;
} {
  let spawns = 0;
  return {
    factory: () => {
      spawns++;
      if (spawns === 1) return first;
      const error = new Error("Cannot find module './compressionWorker.ts'");
      (error as NodeJS.ErrnoException).code = "MODULE_NOT_FOUND";
      throw error;
    },
    spawns: () => spawns,
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

  for (const transientCode of ["EMFILE", "ERR_WORKER_INIT_FAILED"] as const) {
    it(`retries after a transient ${transientCode} spawn failure`, async () => {
      let spawns = 0;
      const worker = fakeWorker();
      const pool = new CompressionWorkerPool({
        size: 1,
        workerFactory: () => {
          spawns++;
          if (spawns === 1) {
            const error = new Error("temporary worker resource exhaustion");
            (error as NodeJS.ErrnoException).code = transientCode;
            throw error;
          }
          return worker;
        },
      });
      try {
        assert.deepEqual(await pool.run(body, "stacked"), {
          body,
          compressed: false,
          stats: null,
        });
        const pending = pool.run(body, "stacked");
        assert.equal(spawns, 2, "transient failure must not permanently break the pool");
        const wireJob = worker.messages[0] as { id: number };
        worker.emit("message", {
          type: "result",
          id: wireJob.id,
          result: { body, compressed: false, stats: null },
        });
        await withTimeout(pending, 5000, "retry after transient failure hung");
      } finally {
        await pool.close();
      }
    });
  }

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

  it("drains a queue populated across a healthy worker when a LATER spawn throws", async () => {
    // First worker takes job 1 and stays busy; jobs 2 and 3 queue behind it.
    // Its runtime error removes it, then replacement spawn throws synchronously
    // → both genuinely queued jobs (plus job 1 via fail()) settle fail-open.
    const first = fakeWorker();
    const { factory, spawns } = workerFactoryThatThrowsAfter(first);
    const pool = new CompressionWorkerPool({ size: 1, workerFactory: factory });
    try {
      const jobs = [
        pool.run(body, "stacked"),
        pool.run(body, "stacked"),
        pool.run(body, "stacked"),
      ];
      assert.equal(first.messages.length, 1, "first worker must be busy with job 1");
      first.emit("error", new Error("worker crashed before replying"));
      const results = await withTimeout(Promise.all(jobs), 5000, "populated queue never drained");
      for (const result of results) {
        assert.deepEqual(result, { body, compressed: false, stats: null });
      }
      const queueLength = (pool as unknown as { queue: unknown[] }).queue.length;
      assert.equal(queueLength, 0, "queue must be empty after the drain");
      assert.equal(spawns(), 2, "must not retry spawning after the throw");
    } finally {
      await pool.close();
    }
  });

  it("fails open (with a warn) when postMessage throws — run() never rejects", async () => {
    const cloneBomb = fakeWorker();
    cloneBomb.postMessage = (() => {
      throw new Error("DataCloneError: object could not be cloned");
    }) as Worker["postMessage"];
    const pool = new CompressionWorkerPool({ size: 1, workerFactory: () => cloneBomb });
    const warn = captureWarn();
    try {
      const result = await withTimeout(pool.run(body, "stacked"), 5000, "postMessage job hung");
      assert.deepEqual(result, { body, compressed: false, stats: null });
      assert.match(warn.lines[0] ?? "", /postMessage failed/);
    } finally {
      warn.restore();
      await pool.close();
    }
  });

  it("fails open (with a warn) on worker runtime error, exit, and job timeout", async () => {
    // error mid-job
    {
      const worker = fakeWorker();
      const pool = new CompressionWorkerPool({ size: 1, workerFactory: () => worker });
      const warn = captureWarn();
      try {
        const pending = pool.run(body, "stacked");
        worker.emit("error", new Error("boom inside worker"));
        assert.deepEqual(await withTimeout(pending, 5000, "error-path job hung"), {
          body,
          compressed: false,
          stats: null,
        });
        assert.match(warn.lines[0] ?? "", /worker error: boom inside worker/);
      } finally {
        warn.restore();
        await pool.close();
      }
    }
    // exit mid-job
    {
      const worker = fakeWorker();
      const pool = new CompressionWorkerPool({ size: 1, workerFactory: () => worker });
      const warn = captureWarn();
      try {
        const pending = pool.run(body, "stacked");
        worker.emit("exit", 1);
        assert.deepEqual(await withTimeout(pending, 5000, "exit-path job hung"), {
          body,
          compressed: false,
          stats: null,
        });
        assert.match(warn.lines[0] ?? "", /worker exit code 1/);
      } finally {
        warn.restore();
        await pool.close();
      }
    }
    // per-job timeout
    {
      const worker = fakeWorker();
      const pool = new CompressionWorkerPool({
        size: 1,
        timeoutMs: 20,
        workerFactory: () => worker,
      });
      const warn = captureWarn();
      try {
        const pending = pool.run(body, "stacked");
        assert.deepEqual(await withTimeout(pending, 5000, "timeout-path job hung"), {
          body,
          compressed: false,
          stats: null,
        });
        assert.match(warn.lines[0] ?? "", /worker job timeout/);
      } finally {
        warn.restore();
        await pool.close();
      }
    }
  });

  it("close() resolves the job of a busy worker — no stranded promise", async () => {
    const worker = fakeWorker();
    const pool = new CompressionWorkerPool({ size: 1, workerFactory: () => worker });
    try {
      const pending = pool.run(body, "stacked"); // worker accepts, never replies
      // Give dispatch() a tick to assign the job to the worker.
      await new Promise((resolve) => setTimeout(resolve, 10));
      await pool.close();
      // The in-flight job must settle fail-open instead of pending forever.
      assert.deepEqual(await withTimeout(pending, 5000, "close stranded the in-flight job"), {
        body,
        compressed: false,
        stats: null,
      });
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
        const error = new Error("Cannot find module './compressionWorker.ts'");
        (error as NodeJS.ErrnoException).code = "MODULE_NOT_FOUND";
        throw error;
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
