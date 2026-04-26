const axios = require('axios');

const SPOTIFY_ACCOUNTS = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API = 'https://api.spotify.com/v1';

const EXPIRY_SKEW_MS = 90 * 1000;
const ME_PROBE_TIMEOUT_MS = 12000;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Safe diagnostics — never log tokens. */
function spotifyTokenDiag(label, payload = {}) {
  console.log(`[SPOTIFY_TOKEN] ${label}`, payload);
}

function expiresAtFromExpiresIn(expiresInSec) {
  const n = Number(expiresInSec);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Date.now() + n * 1000;
}

function applyTokenExpiry(tokens, expiresInSec) {
  const at = expiresAtFromExpiresIn(expiresInSec);
  if (at != null) tokens.expires_at = at;
}

/**
 * Ensure session.hostSpotify.tokens.access_token is valid; refresh if needed.
 * Uses expires_at when present to skip probes; handles 429 on /me with one retry.
 */
async function ensureSpotifyAccessToken(session, env, context = {}) {
  const roomKey = context.roomKey || context.code || '';
  const stage = context.stage || 'ensure';

  const t = session?.hostSpotify?.tokens;
  const now = Date.now();

  const logBase = {
    code: roomKey || null,
    stage,
    hasSession: !!session,
    hasHostSpotify: !!session?.hostSpotify,
    hasAccessToken: !!t?.access_token,
    hasRefreshToken: !!t?.refresh_token,
    expiresAt: t?.expires_at != null ? t.expires_at : null,
    now
  };

  if (!t?.access_token) {
    spotifyTokenDiag('missing_access', { ...logBase, validationStatus: 'no_token' });
    return {
      ok: false,
      status: 401,
      error: 'no_token',
      clientMessage: 'Spotify doit être reconnecté.',
      apiError: 'spotify_no_token'
    };
  }

  if (typeof t.expires_at === 'number' && t.expires_at > now + EXPIRY_SKEW_MS) {
    spotifyTokenDiag('skip_probe_fresh', { ...logBase, validationStatus: 'fresh_cached' });
    return { ok: true };
  }

  let probe = await axios
    .get(`${SPOTIFY_API}/me`, {
      headers: { Authorization: `Bearer ${t.access_token}` },
      validateStatus: () => true,
      timeout: ME_PROBE_TIMEOUT_MS
    })
    .catch(err => ({
      status: err.response?.status || 502,
      data: err.response?.data,
      __network: !err.response
    }));

  if (probe.status === 429) {
    spotifyTokenDiag('me_rate_limited_retry', { ...logBase, validationStatus: '429_retry' });
    await sleep(1200);
    probe = await axios
      .get(`${SPOTIFY_API}/me`, {
        headers: { Authorization: `Bearer ${t.access_token}` },
        validateStatus: () => true,
        timeout: ME_PROBE_TIMEOUT_MS
      })
      .catch(err => ({
        status: err.response?.status || 502,
        data: err.response?.data,
        __network: !err.response
      }));
  }

  if (probe.status === 200) {
    spotifyTokenDiag('me_ok', { ...logBase, validationStatus: 'ok' });
    return { ok: true };
  }

  if (probe.status === 403) {
    spotifyTokenDiag('me_forbidden', { ...logBase, validationStatus: 'forbidden' });
    return {
      ok: false,
      status: 403,
      error: 'spotify_forbidden',
      details: probe.data?.error || null,
      clientMessage: 'Spotify a refusé l’accès (app en mode dev / scopes).',
      apiError: 'spotify_forbidden'
    };
  }

  if (probe.status === 429) {
    spotifyTokenDiag('me_rate_limited', { ...logBase, validationStatus: 'rate_limited' });
    return {
      ok: false,
      status: 429,
      error: 'spotify_rate_limited',
      details: probe.data?.error || null,
      clientMessage: 'Spotify limite les requêtes — réessaie dans un instant.',
      apiError: 'spotify_rate_limited'
    };
  }

  if (probe.status !== 401) {
    spotifyTokenDiag('me_non_auth', {
      ...logBase,
      validationStatus: 'probe_failed',
      probeStatus: probe.status
    });
    return {
      ok: false,
      status: probe.status >= 400 && probe.status < 600 ? probe.status : 502,
      error: 'spotify_token_probe_failed',
      details: probe.data?.error || null,
      clientMessage: 'Spotify indisponible — réessaie.',
      apiError: 'spotify_token_invalid'
    };
  }

  if (!t.refresh_token) {
    spotifyTokenDiag('expired_no_refresh', { ...logBase, validationStatus: 'no_refresh' });
    return {
      ok: false,
      status: 401,
      error: 'spotify_expired_no_refresh',
      clientMessage: 'Spotify doit être reconnecté.',
      apiError: 'spotify_needs_reconnect'
    };
  }

  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) {
    spotifyTokenDiag('server_misconfigured', { ...logBase, validationStatus: 'no_client_env' });
    return {
      ok: false,
      status: 500,
      error: 'no_client',
      clientMessage: 'Configuration Spotify serveur incomplète.',
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
      },
      timeout: ME_PROBE_TIMEOUT_MS
    });
    const { access_token, refresh_token: newRefresh, expires_in } = tokenRes.data;
    session.hostSpotify.tokens.access_token = access_token;
    if (newRefresh) session.hostSpotify.tokens.refresh_token = newRefresh;
    applyTokenExpiry(session.hostSpotify.tokens, expires_in);
    spotifyTokenDiag('refreshed', { ...logBase, validationStatus: 'refreshed' });
    return { ok: true, refreshed: true };
  } catch (e) {
    const data = e.response?.data;
    const isInvalidGrant = data?.error === 'invalid_grant';
    spotifyTokenDiag('refresh_failed', {
      ...logBase,
      validationStatus: isInvalidGrant ? 'refresh_revoked' : 'refresh_error',
      refreshHttpStatus: e.response?.status || null
    });
    return {
      ok: false,
      status: isInvalidGrant ? 401 : e.response?.status || 401,
      error: 'spotify_refresh_failed',
      details: data || e.message,
      clientMessage: isInvalidGrant
        ? 'Session Spotify expirée — reconnecte Spotify.'
        : 'Session Spotify expirée — reconnecte Spotify.',
      apiError: isInvalidGrant ? 'spotify_refresh_revoked' : 'spotify_refresh_failed'
    };
  }
}

/** Alias for call sites that prefer explicit naming. */
const ensureValidSpotifyToken = ensureSpotifyAccessToken;

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
  ensureValidSpotifyToken,
  applyTokenExpiry,
  spotifyTokenDiag,
  getPlaybackState,
  isNothingPlaying,
  transferPlayback,
  startPlayUris,
  addToQueue
};
