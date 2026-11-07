import { describe, expect, it } from 'vitest';
import { eventLoopDrains, flushStream } from '../src/util/exit.js';

describe('flushStream', () => {
  it('writes an empty chunk and waits for the callback', async () => {
    const writes: string[] = [];
    let flushed = false;

    const stream = {
      writable: true,
      destroyed: false,
      write(chunk: string, callback: (error?: Error | null) => void) {
        writes.push(chunk);
        setTimeout(() => {
          flushed = true;
          callback();
        }, 5);
        return true;
      },
    };

    await flushStream(stream);
    expect(writes).toEqual(['']);
    expect(flushed).toBe(true);
  });

  it('does not write to a stream that is not writable', async () => {
    let written = false;
    const stream = {
      writable: false,
      destroyed: false,
      write() {
        written = true;
        return false;
      },
    };

    await flushStream(stream);
    expect(written).toBe(false);
  });

  it('does not write to a destroyed stream', async () => {
    let written = false;
    const stream = {
      writable: true,
      destroyed: true,
      write() {
        written = true;
        return false;
      },
    };

    await flushStream(stream);
    expect(written).toBe(false);
  });

  it('resolves when the stream throws on write', async () => {
    const stream = {
      writable: true,
      destroyed: false,
      write() {
        throw new Error('write after end');
      },
    };

    await expect(flushStream(stream)).resolves.toBeUndefined();
  });

  it('resolves when the write callback reports an error', async () => {
    const stream = {
      writable: true,
      destroyed: false,
      write(_chunk: string, callback: (error?: Error | null) => void) {
        callback(new Error('EPIPE'));
        return false;
      },
    };

    await expect(flushStream(stream)).resolves.toBeUndefined();
  });
});

describe('eventLoopDrains', () => {
  it('reports false when handles keep the loop alive past the grace period', async () => {
    // The test runner owns open handles, so this must time out rather than
    // report a drained loop.
    await expect(eventLoopDrains(10)).resolves.toBe(false);
  });
});
