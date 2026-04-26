const axios = require('axios');

const SPOTIFY_ACCOUNTS = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API = 'https://api.spotify.com/v1';

/**
 * Ensure session.hostSpotify.tokens.access_token is valid; refresh if possible.
 * Always probes /me when an access_token exists (refresh_token may be absent on legacy rows).
 */
async function ensureSpotifyAccessToken(session, env) {
  const t = session?.hostSpotify?.tokens;
  if (!t?.access_token) {
    return {
      ok: false,
      status: 401,
      error: 'no_token',
      clientMessage: 'No Spotify token for this host session. Connect Spotify as host.',
      apiError: 'spotify_no_token'
    };
  }

  const probe = await axios
    .get(`${SPOTIFY_API}/me`, {
      headers: { Authorization: `Bearer ${t.access_token}` },
      validateStatus: () => true
    })
    .catch(() => ({ status: 401 }));

  if (probe.status === 200) return { ok: true };

  if (probe.status === 403) {
    return {
      ok: false,
      status: 403,
      error: 'spotify_forbidden',
      details: probe.data?.error || null,
      clientMessage: 'Spotify denied access. Check app allowlist and scopes.',
      apiError: 'spotify_forbidden'
    };
  }

  if (probe.status !== 401) {
    return {
      ok: false,
      status: probe.status || 502,
      error: 'spotify_token_probe_failed',
      details: probe.data?.error || null,
      clientMessage: 'Could not validate Spotify token. Try again.',
      apiError: 'spotify_token_invalid'
    };
  }

  if (!t.refresh_token) {
    return {
      ok: false,
      status: 401,
      error: 'spotify_expired_no_refresh',
      clientMessage:
        'Spotify access expired and no refresh token is stored. Reconnect Spotify from the host.',
      apiError: 'spotify_needs_reconnect'
    };
  }

  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) {
    return {
      ok: false,
      status: 500,
      error: 'no_client',
      clientMessage: 'Server is missing Spotify client credentials.',
      apiError: 'spotify_server_misconfigured'
    };
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
    const data = e.response?.data;
    const isInvalidGrant = data?.error === 'invalid_grant';
    return {
      ok: false,
      status: isInvalidGrant ? 401 : e.response?.status || 401,
      error: 'spotify_refresh_failed',
      details: data || e.message,
      clientMessage: isInvalidGrant
        ? 'Spotify refresh token is invalid or revoked. Reconnect Spotify from the host.'
        : 'Could not refresh Spotify token. Reconnect Spotify from the host.',
      apiError: isInvalidGrant ? 'spotify_refresh_revoked' : 'spotify_refresh_failed'
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
