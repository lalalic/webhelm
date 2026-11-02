// A Session is stopped by its daemon owner, never by direct tab mutation.
export async function stopMatchingSessions(entries, predicate, stopSession) {
  const stopped = [], errors = [];
  for (const [sessionId, session] of [...entries]) {
    if (!predicate(session)) continue;
    try { stopped.push(await stopSession(sessionId)); }
    catch (error) {
      errors.push({session_id:sessionId,error:String(error?.message || error)});
    }
  }
  return {ok:errors.length === 0,stopped_count:stopped.length,
    error_count:errors.length,stopped,errors};
}
