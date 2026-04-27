const {
  ensureSpotifyAccessToken,
  getPlaybackState,
  isNothingPlaying,
  startPlayUris,
  addToQueue
} = require('./spotifySession');
const { voteThreshold } = require('./voteThreshold');
const { totalPresenceUsers } = require('./roomPresence');

function initSpotifyPipelineState(session) {
  if (!session.spotifyOutbox) session.spotifyOutbox = [];
  if (session.spotifyPipelinePhase == null) session.spotifyPipelinePhase = 'idle';
  if (session.spotifyWaitUri == null) session.spotifyWaitUri = null;
  if (session.spotifyPipelinePhaseDetail == null) session.spotifyPipelinePhaseDetail = null;
}

function spotifyUriForTrack(track) {
  if (track.spotifyUri) return track.spotifyUri;
  if (track.spotifyId) return `spotify:track:${track.spotifyId}`;
  return null;
}

function metaForRoom(session) {
  const n = totalPresenceUsers(session);
  return {
    totalUsers: n,
    voteThreshold: voteThreshold(n),
    spotifyNeedsDevice: !session.spotifyDeviceId,
    playerLost: !!session.playerLost,
    sessionVibe: session.sessionVibe || 'Mix',
    sessionVibeGenres: Array.isArray(session.sessionVibeGenres) ? session.sessionVibeGenres : [],
    sessionVibeSub: 'Basé sur les personnes présentes'
  };
}

/**
 * One tick: refresh token, emit host UX, send at most one Spotify action when allowed.
 */
async function tickSpotifyPipeline({ session, code, io, processEnv, saveSessions }) {
  initSpotifyPipelineState(session);
  if (!session.hostSpotify?.tokens?.access_token) return;

  const tokenRes = await ensureSpotifyAccessToken(session, processEnv, {
    roomKey: code,
    stage: 'pipeline.tick'
  });
  if (!tokenRes.ok) return;
  if (tokenRes.refreshed) saveSessions?.();

  const room = `session:${code}`;
  const state = await getPlaybackState(session);
  const currentUri = state?.item?.uri || null;

  // ── Resolve wait lock (progressive 1-track pipeline) ──
  if (session.spotifyWaitUri) {
    if (session.spotifyPipelinePhaseDetail === 'waiting_until_current') {
      if (currentUri === session.spotifyWaitUri) {
        session.spotifyPipelinePhaseDetail = 'waiting_until_done';
        session._spotifySawOurTrackPlaying = true;
      } else {
        saveSessions?.();
        io.to(room).emit('queue:update', { queue: session.queue, meta: metaForRoom(session) });
        return;
      }
    }
    if (session.spotifyPipelinePhaseDetail === 'waiting_until_done') {
      if (currentUri === session.spotifyWaitUri) {
        session._spotifySawOurTrackPlaying = true;
      }
      if (session._spotifySawOurTrackPlaying && (!currentUri || currentUri !== session.spotifyWaitUri)) {
        session.spotifyWaitUri = null;
        session.spotifyPipelinePhase = 'idle';
        session.spotifyPipelinePhaseDetail = null;
        session.playerLost = false;
        session._spotifySawOurTrackPlaying = false;
      } else {
        saveSessions?.();
        io.to(room).emit('queue:update', { queue: session.queue, meta: metaForRoom(session) });
        return;
      }
    }
  }

  if (!session.spotifyDeviceId) {
    const now = Date.now();
    if (!session._lastNeedsDeviceEmit || now - session._lastNeedsDeviceEmit > 15000) {
      session._lastNeedsDeviceEmit = now;
      io.to(room).emit('room:state', { code, ...metaForRoom(session), spotifyNeedsDevice: true });
    }
    saveSessions?.();
    return;
  }

  if (!session.spotifyOutbox.length) {
    io.to(room).emit('queue:update', { queue: session.queue, meta: metaForRoom(session) });
    return;
  }

  const next = session.spotifyOutbox[0];
  const track = session.queue.find(t => t.id === next.id);
  if (!track || !spotifyUriForTrack(track)) {
    session.spotifyOutbox.shift();
    saveSessions?.();
    return;
  }
  const uri = spotifyUriForTrack(track);

  const dev = session.spotifyDeviceId;
  const nothingPlaying = isNothingPlaying(state);

  try {
    let r;
    if (nothingPlaying) {
      r = await startPlayUris(session, dev, [uri]);
    } else {
      r = await addToQueue(session, dev, uri);
    }

    if (r.status === 204 || r.status === 200) {
      session.spotifyOutbox.shift();
      track.status = 'spotify_queued';
      track.spotifySentAt = new Date().toISOString();
      session.spotifyWaitUri = uri;
      session.spotifyPipelinePhase = 'busy';
      session.spotifyPipelinePhaseDetail = nothingPlaying ? 'waiting_until_done' : 'waiting_until_current';
      session._spotifySawOurTrackPlaying = false;
      session.playerLost = false;
      session._lastNeedsDeviceEmit = 0;
      io.to(room).emit('track:playing', { track, fromServer: true });
    } else if (r.status === 404) {
      session.playerLost = true;
      io.to(room).emit('room:state', { code, ...metaForRoom(session), spotifyNeedsDevice: true, playerLost: true });
    } else {
      session.playerLost = true;
    }
  } catch (e) {
    session.playerLost = true;
  }

  saveSessions?.();
  io.to(room).emit('queue:update', { queue: session.queue, meta: metaForRoom(session) });
}

module.exports = {
  initSpotifyPipelineState,
  spotifyUriForTrack,
  tickSpotifyPipeline,
  metaForRoom
};
