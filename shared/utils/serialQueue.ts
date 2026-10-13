// Run async operations one at a time, in the order they were requested. A
// settings panel sends its reads and writes through one queue so the server
// sees them in that order: a refresh issued during a save goes out only after
// the save completes, and therefore reads the saved state.

export interface SerialQueue {
  /** Run `fn` after every earlier operation has settled (fulfilled or not). */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run(fn) {
      const result = tail.then(fn, fn);
      tail = result.catch(() => undefined);
      return result;
    },
  };
}
