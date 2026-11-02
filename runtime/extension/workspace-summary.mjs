export function summarizeWorkspaces(workspaces, sessions = []) {
  if (!Array.isArray(workspaces)) throw new Error('Workspace list is invalid');
  const configured = workspaces.map(workspace => ({
    name: workspace.name,
    initialized: Boolean(workspace.initialized),
    poolSize: Number.isInteger(workspace.poolSize) ? workspace.poolSize : null,
    idleTabs: workspace.initialized ? workspace.idle : null,
    leasedTabs: workspace.initialized ? workspace.leased : null,
    available: workspace.initialized
      ? Math.max(0, workspace.poolSize - workspace.leased) : null,
    sessions: sessions.filter(session => session.workspace === workspace.name),
    reason: workspace.reason || null,
  }));
  const configuredNames = new Set(configured.map(workspace => workspace.name));
  // A running Session can outlive a deleted workspace group. Do not hide it.
  for (const session of sessions) {
    if (configuredNames.has(session.workspace)) continue;
    configuredNames.add(session.workspace);
    configured.push({
      name: session.workspace, initialized: false, poolSize: null, idleTabs: null,
      leasedTabs: null, available: null, sessions: sessions.filter(s => s.workspace === session.workspace),
      reason: 'not-configured',
    });
  }
  const known = configured.filter(workspace => workspace.initialized && workspace.available !== null);
  return {
    workspaces: configured,
    totalAvailable: configured.length && known.length === configured.length
      ? known.reduce((total, workspace) => total + workspace.available, 0) : null,
    totalPhysicalIdle: known.length === configured.length
      ? known.reduce((total, workspace) => total + workspace.idleTabs, 0) : null,
    totalSessions: sessions.length,
    partial: known.length !== configured.length,
  };
}
