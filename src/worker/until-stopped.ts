/** Rejects with the signal's reason on stop; `work` keeps running, and its later outcome goes to `onSettledAfterStop`. */
export function untilStopped<T>(
  work: Promise<T>,
  signal: AbortSignal,
  onSettledAfterStop: (outcome: PromiseSettledResult<T>) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let stopped = false;
    const onStop = () => {
      stopped = true;
      reject(signal.reason);
    };
    work.then(
      (value) => {
        signal.removeEventListener("abort", onStop);
        if (stopped) onSettledAfterStop({ status: "fulfilled", value });
        else resolve(value);
      },
      (reason: unknown) => {
        signal.removeEventListener("abort", onStop);
        if (stopped) onSettledAfterStop({ status: "rejected", reason });
        else reject(reason);
      },
    );
    if (signal.aborted) onStop();
    else signal.addEventListener("abort", onStop, { once: true });
  });
}
