/** Late read settlement is consumed; aborting a wait never grants new execution authority. */
export function applicationRead<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMs = 2500,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (error: Error | null, value?: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (error) reject(error);
      else resolve(value as T);
    };
    const cancel = () => finish(new Error('APPLICATION_READ_ABORTED'));
    const timer = setTimeout(() => finish(new Error('APPLICATION_READ_TIMEOUT')), timeoutMs);
    signal.addEventListener('abort', cancel, { once: true });
    operation.then(
      (value) => finish(null, value),
      () => finish(new Error('APPLICATION_READ_FAILED')),
    );
    if (signal.aborted) cancel();
  });
}
