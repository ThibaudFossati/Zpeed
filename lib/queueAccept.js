const { voteThreshold } = require('./voteThreshold');
const { totalPresenceUsers } = require('./roomPresence');
const { spotifyUriForTrack, initSpotifyPipelineState, metaForRoom } = require('./spotifyPipeline');

function sortQueueForUi(session) {
  session.queue.sort((a, b) => {
    if (b.votes !== a.votes) return b.votes - a.votes;
    const pa = a.proposedAt ? new Date(a.proposedAt).getTime() : 0;
    const pb = b.proposedAt ? new Date(b.proposedAt).getTime() : 0;
    if (pa !== pb) return pa - pb;
    const aa = a.acceptedAt ? new Date(a.acceptedAt).getTime() : 0;
    const ba = b.acceptedAt ? new Date(b.acceptedAt).getTime() : 0;
    if (aa !== ba) return aa - ba;
    return String(a.id).localeCompare(String(b.id));
  });
}

function sortSpotifyOutbox(session) {
  initSpotifyPipelineState(session);
  session.spotifyOutbox.sort((a, b) => {
    const ta = session.queue.find(x => x.id === a.id);
    const tb = session.queue.find(x => x.id === b.id);
    if (!ta || !tb) return 0;
    if (tb.votes !== ta.votes) return tb.votes - ta.votes;
    return new Date(ta.acceptedAt || 0) - new Date(tb.acceptedAt || 0);
  });
}

/**
 * Promote pending Spotify tracks that reached the dynamic vote threshold.
 */
function tryAcceptSpotifyTracks(session, io, code, saveSessions) {
  initSpotifyPipelineState(session);
  const n = totalPresenceUsers(session);
  const th = voteThreshold(n);
  let changed = false;

  for (const t of session.queue) {
    const uri = spotifyUriForTrack(t);
    if (!uri) continue;
    if (t.status === 'accepted' && t.votes < th) {
      t.status = 'pending';
      delete t.acceptedAt;
      session.spotifyOutbox = session.spotifyOutbox.filter(x => x.id !== t.id);
      changed = true;
    }
  }

  for (const t of session.queue) {
    if (t.status !== 'pending') continue;
    const uri = spotifyUriForTrack(t);
    if (!uri) continue;
    if (t.votes >= th) {
      t.status = 'accepted';
      t.acceptedAt = new Date().toISOString();
      if (!session.spotifyOutbox.some(x => x.id === t.id)) {
        session.spotifyOutbox.push({ id: t.id, uri });
      }
      changed = true;
    }
  }

  sortSpotifyOutbox(session);
  sortQueueForUi(session);

  if (changed) {
    saveSessions();
    io.to(`session:${code}`).emit('queue:update', {
      queue: session.queue,
      meta: metaForRoom(session)
    });
  }
}

module.exports = {
  sortQueueForUi,
  tryAcceptSpotifyTracks,
  metaForRoom
};
