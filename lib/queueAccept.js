const { spotifyUriForTrack, initSpotifyPipelineState, metaForRoom } = require('./spotifyPipeline');

function sortQueueForUi(session) {
  if (!session._arrivalCounter) session._arrivalCounter = 0;
  for (const t of session.queue) {
    if (!Number.isFinite(t.arrivalOrder)) {
      session._arrivalCounter += 1;
      t.arrivalOrder = session._arrivalCounter;
    }
  }
  session.queue.sort((a, b) => {
    if ((a.arrivalOrder || 0) !== (b.arrivalOrder || 0)) return (a.arrivalOrder || 0) - (b.arrivalOrder || 0);
    const pa = a.proposedAt ? new Date(a.proposedAt).getTime() : 0;
    const pb = b.proposedAt ? new Date(b.proposedAt).getTime() : 0;
    if (pa !== pb) return pa - pb;
    return String(a.id).localeCompare(String(b.id));
  });
}

function sortSpotifyOutbox(session) {
  initSpotifyPipelineState(session);
  session.spotifyOutbox.sort((a, b) => {
    const ta = session.queue.find(x => x.id === a.id);
    const tb = session.queue.find(x => x.id === b.id);
    if (!ta || !tb) return 0;
    return (ta.arrivalOrder || 0) - (tb.arrivalOrder || 0);
  });
}

function tryAcceptSpotifyTracks(session, io, code, saveSessions) {
  initSpotifyPipelineState(session);
  const existingOutboxIds = new Set((session.spotifyOutbox || []).map(x => x.id));
  const nextOutbox = [];
  for (const t of session.queue) {
    const uri = spotifyUriForTrack(t);
    if (!uri) continue;
    if (!t.status || t.status === 'accepted') t.status = 'pending';
    if (existingOutboxIds.has(t.id) || t.status === 'spotify_queued' || t.status === 'pending') {
      nextOutbox.push({ id: t.id, uri });
    }
  }
  session.spotifyOutbox = nextOutbox;
  sortSpotifyOutbox(session);
  sortQueueForUi(session);
  saveSessions();
  io.to(`session:${code}`).emit('queue:update', { queue: session.queue, meta: metaForRoom(session) });
}

module.exports = {
  sortQueueForUi,
  tryAcceptSpotifyTracks,
  metaForRoom
};
