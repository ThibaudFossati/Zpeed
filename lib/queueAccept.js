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
    const sa = (Number(a.likes) || 0) - (Number(a.skips) || 0);
    const sb = (Number(b.likes) || 0) - (Number(b.skips) || 0);
    if (sb !== sa) return sb - sa;
    if ((a.arrivalOrder || 0) !== (b.arrivalOrder || 0)) return (a.arrivalOrder || 0) - (b.arrivalOrder || 0);
    const pa = a.proposedAt ? new Date(a.proposedAt).getTime() : 0;
    const pb = b.proposedAt ? new Date(b.proposedAt).getTime() : 0;
    if (pa !== pb) return pa - pb;
    return String(a.id).localeCompare(String(b.id));
  });
}

function sortSpotifyOutbox(session) {
  initSpotifyPipelineState(session);
  const idx = new Map((session.queue || []).map((t, i) => [t.id, i]));
  session.spotifyOutbox.sort((a, b) => {
    const ia = idx.has(a.id) ? idx.get(a.id) : Number.MAX_SAFE_INTEGER;
    const ib = idx.has(b.id) ? idx.get(b.id) : Number.MAX_SAFE_INTEGER;
    return ia - ib;
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
