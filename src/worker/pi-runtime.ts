import {
  type AgentSessionRuntime,
  type CreateAgentSessionFromServicesOptions,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  type ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { untilStopped } from "./until-stopped.js";

export const SESSION_SHUTDOWN_GRACE_MS = 30_000;

/**
 * End the returned runtime with `runtime.dispose()`, not `runtime.session.dispose()`: only the runtime
 * emits `session_shutdown` to extensions, which BlueBear's Pi extension reports as the session end.
 */
export async function createPiSessionRuntime(options: {
  cwd: string;
  modelRuntime: ModelRuntime;
  model: NonNullable<CreateAgentSessionFromServicesOptions["model"]>;
  tools: string[];
  customTools: NonNullable<CreateAgentSessionFromServicesOptions["customTools"]>;
}): Promise<AgentSessionRuntime> {
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime: options.modelRuntime });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model: options.model,
        tools: options.tools,
        customTools: options.customTools,
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  return createAgentSessionRuntime(createRuntime, {
    cwd: options.cwd,
    agentDir: getAgentDir(),
    sessionManager: SessionManager.inMemory(options.cwd),
  });
}

/**
 * Ends the runtime and never rejects. `session.abort()` cannot interrupt an extension `session_shutdown`
 * handler, so after `graceMs` the session is disposed without waiting for the handlers.
 */
export async function disposePiSessionRuntime(
  runtime: AgentSessionRuntime,
  onFailure: (failure: { error: unknown; settledAfterGrace: boolean }) => void,
  graceMs = SESSION_SHUTDOWN_GRACE_MS,
): Promise<void> {
  const grace = new AbortController();
  const timer = setTimeout(
    () => grace.abort(new Error(`extension session_shutdown handlers did not finish within ${graceMs} ms`)),
    graceMs,
  );
  try {
    await untilStopped(runtime.dispose(), grace.signal, (outcome) => {
      if (outcome.status === "rejected") onFailure({ error: outcome.reason, settledAfterGrace: true });
    });
  } catch (error) {
    onFailure({ error, settledAfterGrace: false });
    runtime.session.dispose();
  } finally {
    clearTimeout(timer);
  }
}
