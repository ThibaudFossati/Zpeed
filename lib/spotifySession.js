const axios = require('axios');

const SPOTIFY_ACCOUNTS = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API = 'https://api.spotify.com/v1';

/**
 * Ensure session.hostSpotify.tokens.access_token is valid; refresh if possible.
 */
async function ensureSpotifyAccessToken(session, env) {
  const t = session?.hostSpotify?.tokens;
  if (!t?.access_token) return { ok: false, error: 'no_token' };
  if (!t.refresh_token) return { ok: true };

  const r = await axios
    .get(`${SPOTIFY_API}/me`, {
      headers: { Authorization: `Bearer ${t.access_token}` },
      validateStatus: () => true
    })
    .catch(() => ({ status: 401 }));

  if (r.status === 200) return { ok: true };
  if (r.status === 403) {
    return {
      ok: false,
      status: 403,
      error: 'spotify_forbidden',
      details: r.data?.error || null
    };
  }
  if (r.status !== 401) {
    return {
      ok: false,
      status: r.status || 502,
      error: 'spotify_token_probe_failed',
      details: r.data?.error || null
    };
  }

  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) {
    return { ok: false, error: 'no_client' };
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token
    });
    const tokenRes = await axios.post(SPOTIFY_ACCOUNTS, body.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization:
          'Basic ' +
          Buffer.from(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`).toString('base64')
      }
    });
    const { access_token, refresh_token: newRefresh } = tokenRes.data;
    session.hostSpotify.tokens.access_token = access_token;
    if (newRefresh) session.hostSpotify.tokens.refresh_token = newRefresh;
    return { ok: true, refreshed: true };
  } catch (e) {
    return {
      ok: false,
      status: e.response?.status || 401,
      error: 'spotify_refresh_failed',
      details: e.response?.data || e.message
    };
  }
}

function authHeader(session) {
  return { Authorization: `Bearer ${session.hostSpotify.tokens.access_token}` };
}

async function getPlaybackState(session) {
  const r = await axios.get(`${SPOTIFY_API}/me/player`, {
    headers: authHeader(session),
    validateStatus: () => true
  });
  if (r.status === 204) return null;
  if (r.status !== 200) return null;
  return r.data;
}

/** "Rien ne joue" = pas de lecture active OU is_playing === false */
function isNothingPlaying(state) {
  if (!state || !state.item) return true;
  if (state.is_playing === false) return true;
  return false;
}

async function transferPlayback(session, deviceIds) {
  return axios.put(
    `${SPOTIFY_API}/me/player`,
    { device_ids: deviceIds, play: false },
    { headers: { ...authHeader(session), 'Content-Type': 'application/json' }, validateStatus: () => true }
  );
}

async function startPlayUris(session, deviceId, uris) {
  return axios.put(
    `${SPOTIFY_API}/me/player/play?device_id=${encodeURIComponent(deviceId)}`,
    { uris },
    { headers: { ...authHeader(session), 'Content-Type': 'application/json' }, validateStatus: () => true }
  );
}

async function addToQueue(session, deviceId, uri) {
  return axios.post(
    `${SPOTIFY_API}/me/player/queue?device_id=${encodeURIComponent(deviceId)}&uri=${encodeURIComponent(uri)}`,
    null,
    { headers: authHeader(session), validateStatus: () => true }
  );
}

module.exports = {
  ensureSpotifyAccessToken,
  getPlaybackState,
  isNothingPlaying,
  transferPlayback,
  startPlayUris,
  addToQueue
};
