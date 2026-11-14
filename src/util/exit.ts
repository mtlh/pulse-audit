export interface FlushableStream {
  writable?: boolean;
  destroyed?: boolean;
  write(chunk: string, callback: (error?: Error | null) => void): boolean;
}

/**
 * A blocked pipe must never hang the CLI. The timer is unref'd so it cannot
 * keep the process alive on its own.
 */
const FLUSH_TIMEOUT_MS = 5_000;

/**
 * Resolves once `stream` has accepted and flushed an empty write, which means
 * every earlier chunk has been handed to the OS. Streams that are closed,
 * already destroyed or throw on write resolve immediately.
 */
export function flushStream(stream: FlushableStream): Promise<void> {
  if (stream.writable === false || stream.destroyed === true) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let settled = false;

    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(done, FLUSH_TIMEOUT_MS);
    timer.unref();

    try {
      stream.write('', done);
    } catch {
      done();
    }
  });
}

/**
 * How long to wait for the event loop to drain before forcing the process to
 * exit. Chrome's child process and CDP sockets never release the loop on their
 * own, while commands without those handles drain in well under this window.
 */
export const DRAIN_GRACE_MS = 250;

/**
 * Resolves `true` when Node's event loop empties first (so the process is about
 * to exit on its own) or `false` after `graceMs`, when something is still
 * holding the loop open and the caller should force the exit.
 *
 * The timer is unref'd so it cannot be the handle that keeps the loop alive.
 * Some handles close asynchronously, and calling `process.exit()` while libuv
 * is part-way through a close trips `UV_HANDLE_CLOSING` on Windows, so callers
 * that can drain should be left to exit naturally.
 */
export function eventLoopDrains(graceMs: number = DRAIN_GRACE_MS): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;

    const finish = (drained: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener('beforeExit', onBeforeExit);
      resolve(drained);
    };

    const onBeforeExit = (): void => {
      finish(true);
    };

    const timer = setTimeout(() => {
      finish(false);
    }, graceMs);
    timer.unref();
    process.once('beforeExit', onBeforeExit);
  });
}
