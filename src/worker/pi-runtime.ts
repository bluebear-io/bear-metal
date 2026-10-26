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
