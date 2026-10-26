import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { disposePiSessionRuntime } from "./pi-runtime.js";

function fakeRuntime(dispose: () => Promise<void>) {
  const sessionDispose = vi.fn();
  const runtime = { dispose, session: { dispose: sessionDispose } } as unknown as AgentSessionRuntime;
  return { runtime, sessionDispose };
}

describe("disposePiSessionRuntime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the runtime to end the session", async () => {
    const { runtime, sessionDispose } = fakeRuntime(async () => {});
    const onFailure = vi.fn();

    await disposePiSessionRuntime(runtime, onFailure, 1_000);

    expect(onFailure).not.toHaveBeenCalled();
    expect(sessionDispose).not.toHaveBeenCalled();
  });

  it("disposes the session and reports when session_shutdown handlers outlive the grace period", async () => {
    vi.useFakeTimers();
    const { runtime, sessionDispose } = fakeRuntime(() => new Promise<void>(() => {}));
    const onFailure = vi.fn();

    const disposed = disposePiSessionRuntime(runtime, onFailure, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await disposed;

    expect(sessionDispose).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith({
      error: expect.objectContaining({ message: expect.stringContaining("did not finish within 1000 ms") }),
      settledAfterGrace: false,
    });
  });

  it("reports a runtime dispose rejection instead of throwing it", async () => {
    const failure = new Error("dispose exploded");
    const { runtime, sessionDispose } = fakeRuntime(async () => { throw failure; });
    const onFailure = vi.fn();

    await expect(disposePiSessionRuntime(runtime, onFailure, 1_000)).resolves.toBeUndefined();

    expect(onFailure).toHaveBeenCalledWith({ error: failure, settledAfterGrace: false });
    expect(sessionDispose).toHaveBeenCalledOnce();
  });

  it("reports a throwing forced session dispose instead of throwing it", async () => {
    const failure = new Error("dispose exploded");
    const sessionFailure = new Error("session already disposed");
    const runtime = {
      dispose: async () => { throw failure; },
      session: { dispose: () => { throw sessionFailure; } },
    } as unknown as AgentSessionRuntime;
    const onFailure = vi.fn();

    await expect(disposePiSessionRuntime(runtime, onFailure, 1_000)).resolves.toBeUndefined();

    expect(onFailure.mock.calls).toEqual([
      [{ error: failure, settledAfterGrace: false }],
      [{ error: sessionFailure, settledAfterGrace: false }],
    ]);
  });

  it("reports a rejection that arrives after the grace period", async () => {
    vi.useFakeTimers();
    let rejectDispose!: (error: Error) => void;
    const { runtime } = fakeRuntime(() => new Promise<void>((_, reject) => { rejectDispose = reject; }));
    const onFailure = vi.fn();

    const disposed = disposePiSessionRuntime(runtime, onFailure, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await disposed;
    const late = new Error("late dispose failure");
    rejectDispose(late);
    await vi.advanceTimersByTimeAsync(0);

    expect(onFailure).toHaveBeenLastCalledWith({ error: late, settledAfterGrace: true });
  });
});
