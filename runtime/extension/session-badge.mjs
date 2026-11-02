// Toolbar badge reports daemon-owned Sessions, not browser pool capacity.
export function sessionBadge({connected, sessionCount}) {
  if (!connected) return {
    text: '!', color: '#667085', title: 'WebHelm — daemon offline or status stale',
  };
  if (!Number.isInteger(sessionCount) || sessionCount < 0) return {
    text: '?', color: '#667085', title: 'WebHelm — active session count unavailable',
  };
  return {
    text: sessionCount > 99 ? '99+' : String(sessionCount),
    color: sessionCount === 0 ? '#667085' : '#345FD5',
    title: `WebHelm — ${sessionCount} active Session${sessionCount === 1 ? '' : 's'}`,
  };
}
