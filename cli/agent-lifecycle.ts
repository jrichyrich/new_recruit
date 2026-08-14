import {
  ensureCurrentLocalAgent,
  getLocalAgentLifecycleStatus,
  installLocalAgent,
  restartLocalAgent,
  type LifecycleResult,
  uninstallLocalAgent,
} from "../local/agent/lifecycle";

export type AgentLifecycleDependencies = {
  install: () => Promise<LifecycleResult>;
  status: () => Promise<LifecycleResult>;
  ensureCurrent: () => Promise<LifecycleResult>;
  restart: () => Promise<LifecycleResult>;
  uninstall: () => Promise<LifecycleResult>;
};

const defaultDependencies: AgentLifecycleDependencies = {
  install: installLocalAgent,
  status: getLocalAgentLifecycleStatus,
  ensureCurrent: ensureCurrentLocalAgent,
  restart: restartLocalAgent,
  uninstall: uninstallLocalAgent,
};

export async function runAgentLifecycleCommand(
  action: string,
  dependencies: AgentLifecycleDependencies = defaultDependencies,
): Promise<LifecycleResult> {
  switch (action) {
    case "install":
      return dependencies.install();
    case "status":
      return dependencies.status();
    case "ensure-current":
      return dependencies.ensureCurrent();
    case "restart":
      return dependencies.restart();
    case "uninstall":
      return dependencies.uninstall();
    default:
      throw new Error(`Unknown agent command "${action}".`);
  }
}
