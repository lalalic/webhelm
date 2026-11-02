export function createControlRpc({control, manager, summarizeWorkspaces, scheduleBadge}) {
  return async function controlRpc(method, args = {}) {
    switch (method) {
      case "workspace.control.status": {
        const state = await control.status();
        const summary = summarizeWorkspaces((await manager.list()).workspaces, state.sessions);
        return {...state,...summary};
      }
      case "workspace.control.requestStop":
        return control.requestStop(args.action, args.sessionId, args.workspace);
      case "workspace.control.queueCancel":
        return control.requestQueueCancel(args.queueId);
      case "workspace.control.heartbeat":
        return control.heartbeat(args.sessions, args.queue);
      case "workspace.control.poll": {
        const result = await control.poll(args.sessions, args.queue);
        scheduleBadge();
        return result;
      }
      case "workspace.control.complete":
        return control.complete(args.id, args.response);
      default:
        throw new Error("Unknown workspace control method");
    }
  };
}
