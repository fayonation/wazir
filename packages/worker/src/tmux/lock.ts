/**
 * Per-session async mutex. While input is being delivered to a session,
 * no other delivery for that same session can proceed. Cheap and FIFO.
 */
export class SessionLockMap {
  private readonly locks = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, prior.then(() => next));
    try {
      await prior;
      return await fn();
    } finally {
      release();
      // Best-effort cleanup: if no one's chained behind us, drop the key.
      if (this.locks.get(key) === prior.then(() => next)) {
        this.locks.delete(key);
      }
    }
  }
}
