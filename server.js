require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const YouTube = require('youtube-sr').default;
const { google } = require('googleapis');
const session = require('express-session');
const SpotifyWebApi = require('spotify-web-api-node');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { ensureSpotifyAccessToken, applyTokenExpiry } = require('./lib/spotifySession');
const {
  addHostSocket,
  removeHostSocket,
  addGuestSocket,
  removeGuestSocket
} = require('./lib/roomPresence');
const { tryAcceptSpotifyTracks, sortQueueForUi, metaForRoom } = require('./lib/queueAccept');
const { tickSpotifyPipeline, initSpotifyPipelineState } = require('./lib/spotifyPipeline');

const SPOTIFY_PRECREATE_STATE = '__precreate__';

/** Room codes are stored uppercase; OAuth state must match. Precreate flag is case-insensitive. */
function resolveSessionKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.toLowerCase() === SPOTIFY_PRECREATE_STATE) return SPOTIFY_PRECREATE_STATE;
  return s.toUpperCase();
}

function spotifyDiag(label, payload = {}) {
  console.log(`[SPOTIFY_DIAG] ${label}`, payload);
}

function spotifyApiFailure(res, status, stage, details = {}) {
  const clientMessage =
    typeof details.clientMessage === 'string' && details.clientMessage.trim()
      ? details.clientMessage.trim()
      : null;
  const apiError =
    typeof details.apiError === 'string' && details.apiError.trim()
      ? details.apiError.trim()
      : null;
  const code =
    apiError ||
    (status === 401
      ? 'spotify_unauthorized'
      : status === 403
      ? 'spotify_forbidden'
      : 'spotify_api_error');
  let hint =
    status === 403
      ? 'Spotify Dashboard → Users and Access: add tester emails in Development mode.'
      : null;
  if (stage === 'search.fetch' && status >= 500) {
    hint =
      'Spotify API error. Retry later; or set USE_MOCK_SPOTIFY=true. Ensure SPOTIFY_REDIRECT_URI / PUBLIC_APP_URL match this site in Spotify Dashboard.';
  }
  const mergedDetails =
    Object.keys(details).length || hint ? { ...details, ...(hint ? { hint } : {}) } : {};
  const message =
    clientMessage ||
    (status === 401
      ? 'Spotify token expired or invalid. Reconnect Spotify.'
      : status === 403
      ? 'Spotify access denied. Check app access/allowlist/scopes.'
      : stage === 'search.fetch' && status >= 400 && status < 500
      ? 'Spotify search was rejected. Check token, scopes, and Dashboard settings.'
      : 'Spotify request failed.');
  const needSpotify = details.needSpotify === true;
  const body = { error: code, stage, message, details: mergedDetails };
  if (needSpotify) body.needSpotify = true;
  return res.status(status || 502).json(body);
}

function spotifyEnsureFailure(res, ensure, stage) {
  const d = ensure.details;
  const needSpotify = ['spotify_no_token', 'spotify_needs_reconnect', 'spotify_refresh_revoked', 'spotify_refresh_failed'].includes(
    ensure.apiError
  );
  return spotifyApiFailure(res, ensure.status || 401, stage, {
    ...(d && typeof d === 'object' && !Array.isArray(d) ? d : {}),
    ...(ensure.clientMessage ? { clientMessage: ensure.clientMessage } : {}),
    ...(ensure.apiError ? { apiError: ensure.apiError } : {}),
    needSpotify
  });
}

function hydrateSession(s) {
  if (!s.queue) s.queue = [];
  for (const t of s.queue) {
    if (!t.status) t.status = 'pending';
    if (!t.proposedAt) t.proposedAt = (s.createdAt && new Date(s.createdAt).toISOString()) || new Date().toISOString();
  }
  initSpotifyPipelineState(s);
  if (!s.spotifyOutbox) s.spotifyOutbox = [];
  if (!Array.isArray(s.guests)) s.guests = [];
  if (typeof s.hostSecret !== 'string') s.hostSecret = uuidv4();
}

function isHostSocketAuthorized(socket, code) {
  return socket.role === 'host' && socket.sessionCode === code && socket.hostAuthorized === true;
}

// ─────────────────────────────────────────────
// AI — CLAUDE (DJ comment + roast)
// ─────────────────────────────────────────────
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

async function aiDJComment(title, artist) {
  if (!anthropic) return null;
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 80,
      messages: [{
        role: 'user',
        content: `Tu es un DJ drôle et cool dans une soirée. Le titre "${title}" de "${artist}" vient de démarrer. Écris UNE seule phrase courte (max 12 mots), punchy, style DJ mic, en français. Pas de guillemets, juste la phrase.`
      }]
    });
    return msg.content[0]?.text?.trim() || null;
  } catch (e) {
    console.error('[AI DJ]', e.message);
    return null;
  }
}

async function aiRoast(guestName, title, artist) {
  if (!anthropic) return null;
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 80,
      messages: [{
        role: 'user',
        content: `Tu es un DJ sympa et taquin. ${guestName} a proposé "${title}" de "${artist}" et personne n'a voté pour. Écris UNE phrase courte (max 12 mots), taquine et bienveillante pour ${guestName}, style SMS, en français. Commence par son prénom. Pas de guillemets.`
      }]
    });
    return msg.content[0]?.text?.trim() || null;
  } catch (e) {
    console.error('[AI Roast]', e.message);
    return null;
  }
}

// ─── LAN IP (for QR codes accessible from other phones) ───
function getLanIP() {
  // On Render/cloud, use the PUBLIC_URL env var
  if (process.env.RENDER_EXTERNAL_URL) return null; // handled separately
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}
const LAN_IP = getLanIP();
const PORT = process.env.PORT || 3000;

/** Canonical browser origin for QR / share links (fallback when request has no Host). */
function resolvePublicBase() {
  const fromEnv =
    (
      process.env.PUBLIC_APP_URL ||
      process.env.PUBLIC_URL ||
      process.env.ZPEED_PUBLIC_URL ||
      ''
    )
      .trim()
      .replace(/\/$/, '');
  if (fromEnv) return fromEnv;
  if (process.env.RENDER_EXTERNAL_URL) {
    return String(process.env.RENDER_EXTERNAL_URL).trim().replace(/\/$/, '');
  }
  return `http://${LAN_IP}:${PORT}`;
}

function publicBaseSource() {
  if ((process.env.PUBLIC_APP_URL || '').trim()) return 'PUBLIC_APP_URL';
  if ((process.env.PUBLIC_URL || '').trim()) return 'PUBLIC_URL';
  if ((process.env.ZPEED_PUBLIC_URL || '').trim()) return 'ZPEED_PUBLIC_URL';
  if ((process.env.RENDER_EXTERNAL_URL || '').trim()) return 'RENDER_EXTERNAL_URL';
  return 'lan_ip';
}

const PUBLIC_BASE = resolvePublicBase();

/** Prefer the URL the user actually hit (custom domain behind proxy). */
function getRequestPublicBase(req) {
  if (!req || !req.headers) return PUBLIC_BASE;
  const fwd = (req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = fwd || req.headers.host || '';
  if (!host) return PUBLIC_BASE;
  let proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (!proto) {
    proto = req.secure ? 'https' : 'http';
  }
  if ((host.startsWith('localhost') || host.startsWith('127.')) && proto === 'https') {
    proto = 'http';
  }
  return `${proto}://${host}`.replace(/\/$/, '');
}

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'zpeed_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// ─────────────────────────────────────────────
// GOOGLE OAUTH
// ─────────────────────────────────────────────
const REDIRECT_BASE =
  (
    process.env.PUBLIC_URL ||
    process.env.PUBLIC_APP_URL ||
    process.env.ZPEED_PUBLIC_URL ||
    process.env.REDIRECT_BASE ||
    process.env.RENDER_EXTERNAL_URL ||
    ''
  )
    .trim()
    .replace(/\/$/, '') || 'http://127.0.0.1:3000';

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${REDIRECT_BASE}/auth/google/callback`
);

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email'
];

// Step 1 — Redirect to Google
app.get('/auth/google', (req, res) => {
  const { sessionCode } = req.query;
  const state = sessionCode || '';
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    state
  });
  res.redirect(url);
});

// Step 2 — Google callback
app.get('/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user profile
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: profile } = await oauth2.userinfo.get();

    req.session.googleTokens = tokens;
    req.session.googleProfile = profile;

    // Store auth in sessions map if sessionCode provided
    if (state && sessions[state]) {
      sessions[state].hostGoogle = {
        tokens,
        profile,
        accessToken: tokens.access_token
      };
    }

    // Redirect back to host page
    res.redirect(`/host.html?code=${state}&google=connected`);
  } catch (err) {
    console.error('OAuth error:', err);
    res.redirect('/host.html?error=auth_failed');
  }
});

// Get YouTube playlists of authenticated host
app.get('/api/youtube/playlists', async (req, res) => {
  const { code } = req.query;
  const session_data = sessions[code];

  if (!session_data?.hostGoogle?.tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  client.setCredentials(session_data.hostGoogle.tokens);

  const yt = google.youtube({ version: 'v3', auth: client });
  const { data } = await yt.playlists.list({
    part: 'snippet,contentDetails',
    mine: true,
    maxResults: 20
  });

  const playlists = data.items.map(p => ({
    id: p.id,
    title: p.snippet.title,
    thumbnail: p.snippet.thumbnails?.medium?.url,
    count: p.contentDetails?.itemCount
  }));

  res.json(playlists);
});

// Get tracks from a YouTube playlist
app.get('/api/youtube/playlist/:id', async (req, res) => {
  const { code } = req.query;
  const session_data = sessions[code];

  if (!session_data?.hostGoogle?.tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  client.setCredentials(session_data.hostGoogle.tokens);

  const yt = google.youtube({ version: 'v3', auth: client });
  const { data } = await yt.playlistItems.list({
    part: 'snippet',
    playlistId: req.params.id,
    maxResults: 50
  });

  const tracks = data.items
    .filter(i => i.snippet.resourceId?.videoId)
    .map(i => ({
      videoId: i.snippet.resourceId.videoId,
      title: i.snippet.title,
      channel: i.snippet.videoOwnerChannelTitle || 'YouTube',
      thumbnail: i.snippet.thumbnails?.medium?.url ||
        `https://img.youtube.com/vi/${i.snippet.resourceId.videoId}/mqdefault.jpg`,
      duration: ''
    }));

  res.json(tracks);
});

// ─── AUTH STATUS (toutes les plateformes) ───
app.get('/api/auth/status', (req, res) => {
  const { code } = req.query;
  const s = sessions[resolveSessionKey(code)];
  if (!s) return res.json({ platforms: {} });
  res.json({
    platforms: {
      youtube:    { connected: !!(s.hostGoogle?.tokens),   profile: s.hostGoogle?.profile },
      spotify:    { connected: !!(s.hostSpotify?.tokens),  profile: s.hostSpotify?.profile },
      deezer:     { connected: !!(s.hostDeezer?.token),    profile: s.hostDeezer?.profile },
      apple:      { connected: !!(s.hostApple?.token),     profile: s.hostApple?.profile },
      soundcloud: { connected: !!(s.hostSoundcloud?.token),profile: s.hostSoundcloud?.profile },
    }
  });
});

// ─────────────────────────────────────────────
// SPOTIFY OAUTH
// ─────────────────────────────────────────────
/** Spotify callback URL: explicit SPOTIFY_REDIRECT_URI wins; else PUBLIC_APP_URL / PUBLIC_URL / ZPEED_PUBLIC_URL / REDIRECT_BASE / Render. */
function resolveSpotifyRedirectUri() {
  let explicit = (process.env.SPOTIFY_REDIRECT_URI || '').trim().replace(/\/$/, '');
  if (explicit) {
    if (explicit.endsWith('/auth/spotify/callback')) return explicit;
    return `${explicit}/auth/spotify/callback`;
  }
  const base = (
    (
      process.env.PUBLIC_APP_URL ||
      process.env.PUBLIC_URL ||
      process.env.ZPEED_PUBLIC_URL ||
      ''
    )
      .trim()
      .replace(/\/$/, '') ||
    (process.env.REDIRECT_BASE || '').trim().replace(/\/$/, '') ||
    (process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/$/, '') ||
    'http://127.0.0.1:3000'
  );
  return `${base}/auth/spotify/callback`;
}

const SPOTIFY_REDIRECT = resolveSpotifyRedirectUri();

function useMockSpotify() {
  return process.env.USE_MOCK_SPOTIFY === 'true';
}

function spotifyRedirectSource() {
  if ((process.env.SPOTIFY_REDIRECT_URI || '').trim()) return 'SPOTIFY_REDIRECT_URI';
  if ((process.env.PUBLIC_APP_URL || '').trim()) return 'PUBLIC_APP_URL';
  if ((process.env.PUBLIC_URL || '').trim()) return 'PUBLIC_URL';
  if ((process.env.ZPEED_PUBLIC_URL || '').trim()) return 'ZPEED_PUBLIC_URL';
  if ((process.env.REDIRECT_BASE || '').trim()) return 'REDIRECT_BASE';
  if ((process.env.RENDER_EXTERNAL_URL || '').trim()) return 'RENDER_EXTERNAL_URL';
  return 'default_localhost';
}

const spotifyApi = new SpotifyWebApi({
  clientId:     process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri:  SPOTIFY_REDIRECT
});
const SPOTIFY_SCOPES = [
  'user-read-private',
  'user-read-email',
  'playlist-read-private',
  'playlist-read-collaborative',
  'streaming',
  'user-modify-playback-state',
  'user-read-playback-state'
];

app.get('/api/spotify/oauth-debug', (req, res) => {
  res.json({
    redirectUri: SPOTIFY_REDIRECT,
    redirectSource: spotifyRedirectSource(),
    publicBase: getRequestPublicBase(req),
    publicBaseEnvFallback: PUBLIC_BASE,
    publicBaseSource: publicBaseSource(),
    scopes: SPOTIFY_SCOPES,
    clientIdPresent: !!process.env.SPOTIFY_CLIENT_ID,
    clientSecretPresent: !!process.env.SPOTIFY_CLIENT_SECRET,
    hasClientId: !!process.env.SPOTIFY_CLIENT_ID,
    hasClientSecret: !!process.env.SPOTIFY_CLIENT_SECRET,
    useMockSpotify: useMockSpotify(),
    deployCommit:
      process.env.RENDER_GIT_COMMIT ||
      process.env.COMMIT_REF ||
      process.env.VERCEL_GIT_COMMIT_SHA ||
      null,
    note:
      'Spotify Dashboard → Redirect URIs must include redirectUri above. For custom domains set PUBLIC_URL, PUBLIC_APP_URL, or SPOTIFY_REDIRECT_URI to https://your-domain (and add the callback URL in the Dashboard).'
  });
});

app.get('/auth/spotify', (req, res) => {
  const { sessionCode } = req.query;
  const scopes = SPOTIFY_SCOPES;
  const state = sessionCode ? resolveSessionKey(sessionCode) : '';
  spotifyDiag('oauth_authorize_redirect', {
    sessionCode: sessionCode || null,
    oauthState: state || null,
    redirectUri: SPOTIFY_REDIRECT,
    scopes
  });
  const url = spotifyApi.createAuthorizeURL(scopes, state);
  res.redirect(url);
});

app.get('/auth/spotify/callback', async (req, res) => {
  const { code: authCode, state } = req.query;
  console.log('[SPOTIFY] callback received');
  try {
    // ── Step 1: Exchange code for tokens ──────────────────────────────────────
    const tokenRes = await axios.post('https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: authCode,
        redirect_uri: SPOTIFY_REDIRECT
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(
            process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET
          ).toString('base64')
        }
      }
    );
    console.log(`[SPOTIFY] token exchange success (status: ${tokenRes.status})`);
    const { access_token, refresh_token, token_type, scope, expires_in } = tokenRes.data;
    spotifyDiag('oauth_token_exchange', {
      status: tokenRes.status,
      state: state || null,
      redirectUri: SPOTIFY_REDIRECT,
      tokenType: token_type || null,
      scope: scope || null,
      expiresIn: expires_in || null
    });

    // ── Step 2: Fetch user profile (use a fresh per-request instance to avoid race conditions) ──
    let profile = { name: 'Spotify', picture: null, email: null };
    try {
      const meRes = await axios.get('https://api.spotify.com/v1/me', {
        headers: { Authorization: `Bearer ${access_token}` },
        validateStatus: () => true
      });
      if (meRes.status === 200) {
        const me = meRes.data;
        profile = {
          name: me.display_name || me.id || 'Spotify',
          picture: me.images?.[0]?.url || null,
          email: me.email || null
        };
        console.log(`[SPOTIFY] profile fetch status: ${meRes.status}`);
      } else {
        spotifyDiag('oauth_getme_non200', {
          status: meRes.status,
          state: state || null,
          tokenType: token_type || null,
          grantedScope: scope || null,
          redirectUri: SPOTIFY_REDIRECT,
          responseError: meRes.data?.error || meRes.data || null
        });
      }
    } catch (profileErr) {
      spotifyDiag('oauth_getme_exception', {
        state: state || null,
        tokenType: token_type || null,
        grantedScope: scope || null,
        redirectUri: SPOTIFY_REDIRECT,
        error: profileErr.response?.data || profileErr.message
      });
    }

    // ── Pré-connexion (avant création de room) ─────────────────────────────────
    if (state && String(state).trim().toLowerCase() === SPOTIFY_PRECREATE_STATE) {
      const prev = req.session.pendingHostSpotify?.tokens || {};
      const pendingTokens = {
        access_token,
        refresh_token: refresh_token || prev.refresh_token || undefined
      };
      applyTokenExpiry(pendingTokens, expires_in);
      req.session.pendingHostSpotify = {
        tokens: pendingTokens,
        profile
      };
      return res.redirect('/index.html?spotify_ready=1');
    }

    // ── Step 3: Store in session if it exists (state normalized to room key) ──
    const stateKey = resolveSessionKey(state);
    if (stateKey && sessions[stateKey]) {
      const prev = sessions[stateKey].hostSpotify?.tokens || {};
      const roomTokens = {
        access_token,
        refresh_token: refresh_token || prev.refresh_token || undefined
      };
      applyTokenExpiry(roomTokens, expires_in);
      sessions[stateKey].hostSpotify = {
        tokens: roomTokens,
        profile
      };
      saveSessions();
      console.log('Spotify stored in session:', stateKey);
    } else {
      console.warn(
        'No session found for OAuth state:',
        state,
        'resolved:',
        stateKey || '(empty)',
        '— token will not be persisted server-side'
      );
    }

    const redirectCode = encodeURIComponent(stateKey || String(state || '').trim());
    return res.redirect(`/host.html?code=${redirectCode}&platform=spotify`);
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    const safe =
      body && typeof body === 'object'
        ? { error: body.error, error_description: body.error_description }
        : { message: err.message };
    spotifyDiag('oauth_callback_failed', {
      status: status || null,
      redirectUri: SPOTIFY_REDIRECT,
      redirectSource: spotifyRedirectSource(),
      ...safe
    });
    console.error('[SPOTIFY] OAuth callback failed', { status, ...safe });
    res.redirect('/host.html?error=spotify_failed');
  }
});

// ── Return stored Spotify token to host client (Web Playback SDK) — requires hostSecret ──
app.get('/api/spotify/token', async (req, res) => {
  const { code, secret } = req.query;
  const roomKey = resolveSessionKey(code);
  const s = sessions[roomKey];
  if (!secret || s?.hostSecret !== secret) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!s?.hostSpotify?.tokens?.access_token) {
    return res.status(404).json({
      error: 'spotify_not_connected',
      needSpotify: true,
      message: 'Spotify doit être reconnecté.'
    });
  }
  const ensure = await ensureSpotifyAccessToken(s, process.env, { roomKey, stage: 'token.endpoint' });
  if (!ensure.ok) {
    const needSpotify = ['spotify_no_token', 'spotify_needs_reconnect', 'spotify_refresh_revoked', 'spotify_refresh_failed'].includes(
      ensure.apiError
    );
    return res.status(ensure.status || 401).json({
      error: ensure.apiError || 'spotify_token_invalid',
      needSpotify,
      message: ensure.clientMessage || 'Spotify indisponible — réessaie.'
    });
  }
  if (ensure.refreshed) saveSessions();
  res.json({
    access_token: s.hostSpotify.tokens.access_token,
    profile: s.hostSpotify.profile || null,
    use_mock_spotify: useMockSpotify()
  });
});

app.get('/api/spotify/playlists', async (req, res) => {
  const { code } = req.query;
  const roomKey = resolveSessionKey(code);
  const s = sessions[roomKey];
  if (!s?.hostSpotify?.tokens) return res.status(401).json({ error: 'Not connected' });
  const ensure = await ensureSpotifyAccessToken(s, process.env, { roomKey, stage: 'playlists.ensure_token' });
  if (!ensure.ok) {
    spotifyDiag('spotify_playlists_token_invalid', { code: roomKey, error: ensure.error });
    return spotifyEnsureFailure(res, ensure, 'playlists.ensure_token');
  }
  if (ensure.refreshed) saveSessions();
  spotifyApi.setAccessToken(s.hostSpotify.tokens.access_token);
  try {
    const data = await spotifyApi.getUserPlaylists({ limit: 20 });
    res.json(data.body.items.map(p => ({
      id: p.id, title: p.name,
      thumbnail: p.images?.[0]?.url,
      count: p.tracks?.total
    })));
  } catch (e) {
    const status = e.statusCode || e.status || e.response?.statusCode || 502;
    spotifyDiag('spotify_playlists_failed', {
      code: roomKey,
      status,
      error: e.body || e.message
    });
    return spotifyApiFailure(res, status, 'playlists.fetch');
  }
});

app.get('/api/spotify/playlist/:id', async (req, res) => {
  const { code } = req.query;
  const roomKey = resolveSessionKey(code);
  const s = sessions[roomKey];
  if (!s?.hostSpotify?.tokens) return res.status(401).json({ error: 'Not connected' });
  const ensure = await ensureSpotifyAccessToken(s, process.env, { roomKey, stage: 'playlist_tracks.ensure_token' });
  if (!ensure.ok) {
    spotifyDiag('spotify_playlist_tracks_token_invalid', {
      code: roomKey,
      playlistId: req.params.id,
      error: ensure.error
    });
    return spotifyEnsureFailure(res, ensure, 'playlist_tracks.ensure_token');
  }
  if (ensure.refreshed) saveSessions();
  spotifyApi.setAccessToken(s.hostSpotify.tokens.access_token);
  try {
    const data = await spotifyApi.getPlaylistTracks(req.params.id, { limit: 50 });
    const tracks = data.body.items
      .filter(i => i.track)
      .map(i => ({
        videoId:   null,
        spotifyId: i.track.id,
        title:     i.track.name,
        channel:   i.track.artists.map(a => a.name).join(', '),
        thumbnail: i.track.album?.images?.[0]?.url,
        preview:   i.track.preview_url,
        platform:  'spotify',
        duration:  Math.floor(i.track.duration_ms / 1000) + 's'
      }));
    res.json(tracks);
  } catch (e) {
    const status = e.statusCode || e.status || e.response?.statusCode || 502;
    spotifyDiag('spotify_playlist_tracks_failed', {
      code: roomKey,
      playlistId: req.params.id,
      status,
      error: e.body || e.message
    });
    return spotifyApiFailure(res, status, 'playlist_tracks.fetch');
  }
});

// ─────────────────────────────────────────────
// DEEZER OAUTH
// ─────────────────────────────────────────────
app.get('/auth/deezer', (req, res) => {
  const { sessionCode } = req.query;
  const perms = 'basic_access,email,manage_library';
  const url = `https://connect.deezer.com/oauth/auth.php?app_id=${process.env.DEEZER_APP_ID}&redirect_uri=${encodeURIComponent('http://localhost:3000/auth/deezer/callback')}&perms=${perms}&state=${sessionCode || ''}`;
  res.redirect(url);
});

app.get('/auth/deezer/callback', async (req, res) => {
  const { code: authCode, state } = req.query;
  try {
    const tokenRes = await axios.get(`https://connect.deezer.com/oauth/access_token.php?app_id=${process.env.DEEZER_APP_ID}&secret=${process.env.DEEZER_SECRET_KEY}&code=${authCode}&output=json`);
    const token = tokenRes.data.access_token;
    const me = await axios.get(`https://api.deezer.com/user/me?access_token=${token}`);

    if (state && sessions[state]) {
      sessions[state].hostDeezer = {
        token,
        profile: { name: me.data.name, picture: me.data.picture_medium }
      };
    }
    res.redirect(`/host.html?code=${state}&platform=deezer`);
  } catch (err) {
    console.error('Deezer OAuth error:', err);
    res.redirect('/host.html?error=deezer_failed');
  }
});

app.get('/api/deezer/playlists', async (req, res) => {
  const { code } = req.query;
  const s = sessions[code];
  if (!s?.hostDeezer?.token) return res.status(401).json({ error: 'Not connected' });
  const data = await axios.get(`https://api.deezer.com/user/me/playlists?access_token=${s.hostDeezer.token}`);
  res.json(data.data.data.map(p => ({
    id: p.id, title: p.title,
    thumbnail: p.picture_medium,
    count: p.nb_tracks
  })));
});

app.get('/api/deezer/playlist/:id', async (req, res) => {
  const { code } = req.query;
  const s = sessions[code];
  if (!s?.hostDeezer?.token) return res.status(401).json({ error: 'Not connected' });
  const data = await axios.get(`https://api.deezer.com/playlist/${req.params.id}/tracks?access_token=${s.hostDeezer.token}`);
  res.json(data.data.data.map(t => ({
    videoId:   null,
    deezerId:  t.id,
    title:     t.title,
    channel:   t.artist?.name,
    thumbnail: t.album?.cover_medium,
    preview:   t.preview,
    platform:  'deezer',
    duration:  t.duration + 's'
  })));
});

// ─────────────────────────────────────────────
// SOUNDCLOUD OAUTH
// ─────────────────────────────────────────────
app.get('/auth/soundcloud', (req, res) => {
  const { sessionCode } = req.query;
  const url = `https://api.soundcloud.com/connect?client_id=${process.env.SOUNDCLOUD_CLIENT_ID}&redirect_uri=${encodeURIComponent('http://localhost:3000/auth/soundcloud/callback')}&response_type=code&state=${sessionCode || ''}`;
  res.redirect(url);
});

app.get('/auth/soundcloud/callback', async (req, res) => {
  const { code: authCode, state } = req.query;
  try {
    const tokenRes = await axios.post('https://api.soundcloud.com/oauth2/token', {
      client_id: process.env.SOUNDCLOUD_CLIENT_ID,
      client_secret: process.env.SOUNDCLOUD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: 'http://localhost:3000/auth/soundcloud/callback',
      code: authCode
    });
    const token = tokenRes.data.access_token;
    const me = await axios.get('https://api.soundcloud.com/me', { headers: { Authorization: `Bearer ${token}` } });

    if (state && sessions[state]) {
      sessions[state].hostSoundcloud = {
        token,
        profile: { name: me.data.full_name || me.data.username, picture: me.data.avatar_url }
      };
    }
    res.redirect(`/host.html?code=${state}&platform=soundcloud`);
  } catch (err) {
    console.error('SoundCloud OAuth error:', err);
    res.redirect('/host.html?error=soundcloud_failed');
  }
});

// ─────────────────────────────────────────────
// APPLE MUSIC (MusicKit — client-side token)
// ─────────────────────────────────────────────
app.get('/auth/apple/token', (req, res) => {
  // Apple Music utilise MusicKit JS côté client
  // Le developerToken est signé côté serveur avec la clé privée Apple
  res.json({ configured: !!(process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID) });
});

// ─────────────────────────────────────────────
// SESSION PERSISTENCE (survives restarts)
// ─────────────────────────────────────────────
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
      const saved = JSON.parse(raw);
      // Only restore sessions created within the last 12 hours
      const cutoff = Date.now() - 12 * 60 * 60 * 1000;
      for (const [code, s] of Object.entries(saved)) {
        if (new Date(s.createdAt).getTime() > cutoff) {
          delete s._presence;
          sessions[code] = s;
          hydrateSession(sessions[code]);
        }
      }
      console.log(`📂 Loaded ${Object.keys(sessions).length} active session(s) from disk`);
    }
  } catch (e) {
    console.warn('Could not load sessions.json:', e.message);
  }
}

function saveSessions() {
  try {
    const out = {};
    for (const [code, s] of Object.entries(sessions)) {
      const { _presence, ...rest } = s;
      out[code] = rest;
    }
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(out, null, 2));
  } catch (e) {
    console.warn('Could not save sessions.json:', e.message);
  }
}

// ─────────────────────────────────────────────
// IN-MEMORY DATA
// ─────────────────────────────────────────────
const sessions = {};
loadSessions();

// speakerSessions : speakerName → sessionCode
const speakerSessions = {};

// ─────────────────────────────────────────────
// REST ROUTES
// ─────────────────────────────────────────────

// ─── NOUVELLE ROUTE : connecter une enceinte ───
// Logique centrale : 1er connecté = HOST, suivants = GUEST
app.post('/api/speaker/connect', async (req, res) => {
  const { speakerName, speakerId, userName } = req.body;
  const key = speakerId || speakerName;

  // Y'a déjà une session active pour cette enceinte ?
  const existingCode = speakerSessions[key];

  if (existingCode && sessions[existingCode]) {
    // ── GUEST : session déjà en cours ──
    const session = sessions[existingCode];
    const guestId = uuidv4();
    session.guests.push({ id: guestId, name: userName || 'Guest' });
    session.guestCount++;

    return res.json({
      role: 'guest',
      code: existingCode,
      guestId,
      hostName: session.hostName,
      speakerName,
      message: `Tu rejoins la session de ${session.hostName}`
    });
  }

  // ── HOST : premier connecté à cette enceinte ──
  const pending = req.session?.pendingHostSpotify;
  if (!pending?.tokens?.access_token) {
    return res.status(403).json({
      success: false,
      needSpotify: true,
      message: 'Connecte Spotify avant de créer une session.'
    });
  }

  const code = Math.random().toString(36).substring(2, 6).toUpperCase();
  const hostId = uuidv4();
  const hostSecret = uuidv4();

  sessions[code] = {
    code,
    hostId,
    hostSecret,
    hostName: userName || 'Host',
    speakerName,
    speakerId: key,
    guestCount: 0,
    queue: [],
    currentTrack: null,
    guests: [],
    hostGoogle: null,
    hostSpotify: { tokens: { ...pending.tokens }, profile: pending.profile || { name: 'Spotify' } },
    spotifyOutbox: [],
    spotifyDeviceId: null,
    playerLost: false,
    createdAt: new Date()
  };
  hydrateSession(sessions[code]);
  delete req.session.pendingHostSpotify;
  saveSessions();

  // Lier l'enceinte à cette session
  speakerSessions[key] = code;

  const base = getRequestPublicBase(req);
  const joinUrl = `${base}/?speaker=${encodeURIComponent(speakerName)}&speakerId=${encodeURIComponent(key)}`;
  const qrDataUrl = await QRCode.toDataURL(joinUrl, {
    color: { dark: '#7B52D4', light: '#1a1a1a' },
    width: 300, margin: 2
  });

  res.json({
    role: 'host',
    code,
    hostId,
    hostSecret,
    qrDataUrl,
    joinUrl,
    speakerName,
    message: `Tu es le HOST de cette session`
  });
});

// Quand le host quitte → libère l'enceinte
app.post('/api/speaker/disconnect', (req, res) => {
  const { speakerId, code } = req.body;
  if (speakerId) delete speakerSessions[speakerId];
  if (code) delete sessions[code];
  res.json({ success: true });
});

app.post('/api/session/create', async (req, res) => {
  const pending = req.session?.pendingHostSpotify;
  if (!pending?.tokens?.access_token) {
    return res.status(403).json({
      success: false,
      needSpotify: true,
      message: 'Connecte Spotify avant de créer une soirée.'
    });
  }

  const { hostName } = req.body;
  const code = Math.random().toString(36).substring(2, 6).toUpperCase();
  const hostId = uuidv4();
  const hostSecret = uuidv4();

  sessions[code] = {
    code,
    hostId,
    hostSecret,
    hostName: hostName || 'Host',
    guestCount: 0,
    queue: [],
    currentTrack: null,
    guests: [],
    hostGoogle: null,
    hostSpotify: { tokens: { ...pending.tokens }, profile: pending.profile || { name: 'Spotify' } },
    spotifyOutbox: [],
    spotifyDeviceId: null,
    playerLost: false,
    createdAt: new Date()
  };
  hydrateSession(sessions[code]);
  delete req.session.pendingHostSpotify;
  saveSessions();

  const base = getRequestPublicBase(req);
  const joinUrl = `${base}/?code=${code}`;
  const qrDataUrl = await QRCode.toDataURL(joinUrl, {
    color: { dark: '#7B52D4', light: '#1a1a1a' },
    width: 300, margin: 2
  });
  // Raw matrix for live canvas rendering
  const qrObj = QRCode.create(joinUrl, { errorCorrectionLevel: 'M' });
  const qrMatrix = Array.from(qrObj.modules.data);
  const qrSize   = qrObj.modules.size;

  res.json({ success: true, code, hostId, hostSecret, qrDataUrl, joinUrl, lanIP: LAN_IP, qrMatrix, qrSize });
});

app.post('/api/session/join', (req, res) => {
  const { code, guestName } = req.body;
  const session = sessions[code];
  if (!session) return res.status(404).json({ success: false, message: 'Session introuvable' });
  if (!session.hostSpotify?.tokens?.access_token) {
    return res.status(403).json({ success: false, message: 'Cette session n\'accepte pas encore de guests.' });
  }

  const guestId = uuidv4();
  session.guests.push({ id: guestId, name: guestName || 'Guest' });
  session.guestCount++;
  saveSessions();

  res.json({
    success: true, guestId,
    sessionCode: code,
    hostName: session.hostName,
    queue: session.queue,
    currentTrack: session.currentTrack
  });
});

app.get('/api/session/:code', (req, res) => {
  const session = sessions[req.params.code];
  if (!session) return res.status(404).json({ error: 'Not found' });
  res.json({
    code: session.code,
    hostName: session.hostName,
    guestCount: session.guestCount,
    guestList: session.guests,
    queue: session.queue,
    currentTrack: session.currentTrack,
    googleConnected: !!(session.hostGoogle),
    meta: metaForRoom(session)
  });
});

app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  try {
    const results = await YouTube.search(q, { limit: 6, type: 'video' });
    res.json(results.map(v => ({
      videoId: v.id,
      title: v.title,
      channel: v.channel?.name || 'Unknown',
      thumbnail: v.thumbnail?.url || `https://img.youtube.com/vi/${v.id}/mqdefault.jpg`,
      duration: v.durationFormatted
    })));
  } catch (err) {
    console.error('YouTube search error:', err.message);
    res.json([]);
  }
});

// ─────────────────────────────────────────────
// SOCKET.IO
// ─────────────────────────────────────────────
io.on('connection', (socket) => {
  const voterKeyForSocket = (s, sock) => {
    if (sock.role === 'host' && s?.hostId) return `host:${s.hostId}`;
    if (sock.role === 'guest' && sock.guestId) return sock.guestId;
    return null;
  };

  socket.on('host:join', ({ code, hostId, hostSecret }) => {
    const s = sessions[code];
    if (!s || s.hostId !== hostId || s.hostSecret !== hostSecret) return;
    socket.join(`session:${code}`);
    socket.sessionCode = code;
    socket.role = 'host';
    socket.hostAuthorized = true;
    addHostSocket(s, socket.id);
    saveSessions();
    io.to(`session:${code}`).emit('session:update', {
      guestCount: s.guestCount,
      guestList: s.guests,
      queue: s.queue,
      meta: metaForRoom(s)
    });
    io.to(`session:${code}`).emit('room:state', { code, ...metaForRoom(s) });
  });

  socket.on('host:spotify_device', ({ code, hostSecret, deviceId }) => {
    const s = sessions[code];
    if (!s || s.hostSecret !== hostSecret) return;
    if (deviceId) {
      s.spotifyDeviceId = deviceId;
      s.playerLost = false;
    }
    saveSessions();
    io.to(`session:${code}`).emit('room:state', { code, ...metaForRoom(s) });
    tickSpotifyPipeline({ session: s, code, io, processEnv: process.env, saveSessions }).catch(() => {});
  });

  socket.on('host:playback_lost', ({ code, hostSecret }) => {
    const s = sessions[code];
    if (!s || s.hostSecret !== hostSecret) return;
    s.playerLost = true;
    saveSessions();
    io.to(`session:${code}`).emit('room:state', {
      code,
      spotifyNeedsDevice: !s.spotifyDeviceId,
      playerLost: true
    });
  });

  socket.on('guest:join', ({ code, guestId, guestName }) => {
    const s = sessions[code];
    if (!s) return;
    socket.join(`session:${code}`);
    socket.sessionCode = code;
    socket.role = 'guest';
    socket.guestId = guestId;
    socket.guestName = guestName;
    socket.data.guestId = guestId;
    socket.data.code = code;
    addGuestSocket(s, guestId, socket.id);

    io.to(`session:${code}`).emit('session:update', {
      guestCount: s.guestCount,
      guestList: s.guests,
      queue: s.queue,
      meta: metaForRoom(s)
    });
    io.to(`session:${code}`).emit('room:state', { code, ...metaForRoom(s) });
    io.to(`session:${code}`).emit('notification', {
      message: `🎉 ${guestName} a rejoint la session !`
    });
    tryAcceptSpotifyTracks(s, io, code, saveSessions);
  });

  socket.on('track:propose', ({ code, guestId, hostId, guestName, userName, track }) => {
    const s = sessions[code];
    if (!s) return;
    const name = guestName || userName || 'Anonyme';
    const proposerKey =
      guestId || (hostId && s.hostId === hostId ? `host:${s.hostId}` : `anon:${socket.id}`);
    const trackId = uuidv4();
    const newTrack = {
      id: trackId,
      ...track,
      votes: 1,
      proposedBy: name,
      voters: [proposerKey],
      voterNames: [name],
      status: 'pending',
      proposedAt: new Date().toISOString(),
      platform: track.platform || (track.spotifyUri || track.spotifyId ? 'spotify' : 'youtube')
    };
    s.queue.push(newTrack);
    sortQueueForUi(s);
    saveSessions();
    io.to(`session:${code}`).emit('queue:update', { queue: s.queue, meta: metaForRoom(s) });
    io.to(`session:${code}`).emit('notification', { message: `🎵 ${name} a proposé "${track.title}"` });
    tryAcceptSpotifyTracks(s, io, code, saveSessions);
    tickSpotifyPipeline({ session: s, code, io, processEnv: process.env, saveSessions }).catch(() => {});

    setTimeout(() => {
      const sess = sessions[code];
      if (!sess) return;
      const t = sess.queue.find(q => q.id === trackId);
      if (t && t.votes <= 1) {
        aiRoast(name, track.title, track.artist || track.channel).then(roast => {
          if (roast) {
            const targetSocket = [...io.sockets.sockets.values()].find(
              sk => sk.data && sk.data.guestId === guestId && sk.data.code === code
            );
            if (targetSocket) {
              targetSocket.emit('ai:roast', { roast, trackId });
            } else {
              io.to(`session:${code}`).emit('ai:roast', { roast, trackId, guestId });
            }
          }
        });
      }
    }, 45 * 1000);
  });

  socket.on('track:vote', ({ code, trackId, guestId, guestName, userName, vote, hostId }) => {
    const s = sessions[code];
    if (!s) return;
    const voterKey =
      guestId ||
      (hostId && s.hostId === hostId ? `host:${s.hostId}` : null) ||
      voterKeyForSocket(s, socket);
    if (!voterKey) return;
    const track = s.queue.find(t => t.id === trackId);
    if (!track || track.voters.includes(voterKey)) return;
    track.votes += vote;
    track.voters.push(voterKey);
    if (!track.voterNames) track.voterNames = [];
    const name = guestName || userName || 'Someone';
    if (!track.voterNames.includes(name)) track.voterNames.push(name);
    sortQueueForUi(s);
    tryAcceptSpotifyTracks(s, io, code, saveSessions);
    io.to(`session:${code}`).emit('queue:update', { queue: s.queue, meta: metaForRoom(s) });
    if (vote > 0) {
      io.to(`session:${code}`).emit('track:voted', {
        trackId,
        voterName: name,
        initials: name.substring(0, 2).toUpperCase(),
        votes: track.votes
      });
    }
    tickSpotifyPipeline({ session: s, code, io, processEnv: process.env, saveSessions }).catch(() => {});
  });

  socket.on('track:react', ({ code, trackId, guestId, guestName, emoji }) => {
    const s = sessions[code];
    if (!s) return;
    const name = guestName || 'Someone';
    io.to(`session:${code}`).emit('track:reaction', {
      trackId,
      guestName: name,
      initials: name.substring(0, 2).toUpperCase(),
      emoji
    });
  });

  socket.on('track:play', ({ code, trackId }) => {
    if (!isHostSocketAuthorized(socket, code)) return;
    const s = sessions[code];
    if (!s) return;
    const track = s.queue.find(t => t.id === trackId);
    if (!track) return;
    s.currentTrack = track;
    s.queue = s.queue.filter(t => t.id !== trackId);
    io.to(`session:${code}`).emit('track:playing', { track, fromServer: false });
    io.to(`session:${code}`).emit('queue:update', { queue: s.queue, meta: metaForRoom(s) });
    aiDJComment(track.title, track.artist || track.channel).then(comment => {
      if (comment) io.to(`session:${code}`).emit('ai:dj_comment', { comment, track });
    });
    saveSessions();
  });

  socket.on('track:skip', ({ code }) => {
    if (!isHostSocketAuthorized(socket, code)) return;
    const s = sessions[code];
    if (!s) return;
    if (s.queue.length > 0) {
      const next = s.queue.shift();
      s.currentTrack = next;
      io.to(`session:${code}`).emit('track:playing', { track: next, fromServer: false });
      io.to(`session:${code}`).emit('queue:update', { queue: s.queue, meta: metaForRoom(s) });
    } else {
      s.currentTrack = null;
      io.to(`session:${code}`).emit('track:playing', { track: null, fromServer: false });
      io.to(`session:${code}`).emit('queue:update', { queue: s.queue, meta: metaForRoom(s) });
    }
    saveSessions();
  });

  socket.on('session:end', ({ code }) => {
    if (!isHostSocketAuthorized(socket, code)) return;
    const s = sessions[code];
    if (!s) return;
    io.to(`session:${code}`).emit('session:ended', {});
    delete sessions[code];
    saveSessions();
  });

  socket.on('track:add_from_playlist', ({ code, track }) => {
    if (!isHostSocketAuthorized(socket, code)) return;
    const s = sessions[code];
    if (!s) return;
    const newTrack = {
      id: uuidv4(),
      ...track,
      votes: 0,
      proposedBy: '🎧 Host',
      voters: [],
      voterNames: [],
      status: 'pending',
      proposedAt: new Date().toISOString(),
      platform: track.platform || (track.spotifyUri || track.spotifyId ? 'spotify' : 'youtube')
    };
    s.queue.push(newTrack);
    sortQueueForUi(s);
    saveSessions();
    io.to(`session:${code}`).emit('queue:update', { queue: s.queue, meta: metaForRoom(s) });
    io.to(`session:${code}`).emit('notification', { message: `🎧 Host a ajouté "${track.title}"` });
    tryAcceptSpotifyTracks(s, io, code, saveSessions);
    tickSpotifyPipeline({ session: s, code, io, processEnv: process.env, saveSessions }).catch(() => {});
  });

  socket.on('disconnect', () => {
    const code = socket.sessionCode;
    if (!code || !sessions[code]) return;
    const s = sessions[code];
    if (socket.role === 'host') {
      removeHostSocket(s, socket.id);
    } else if (socket.role === 'guest' && socket.guestId) {
      removeGuestSocket(s, socket.guestId, socket.id);
    }
    tryAcceptSpotifyTracks(s, io, code, saveSessions);
    io.to(`session:${code}`).emit('room:state', { code, ...metaForRoom(s) });
    saveSessions();
  });
});

// ─────────────────────────────────────────────
// CONFIG ENDPOINT (for frontend to know LAN IP)
// ─────────────────────────────────────────────

// Store Spotify token from client-side PKCE flow
app.post('/api/spotify/store-token', (req, res) => {
  const { code } = req.query;
  const { access_token } = req.body;
  const s = sessions[code];
  if (!s) return res.status(404).json({ error: 'Session not found' });
  s.hostSpotify = { tokens: { access_token }, profile: { name: 'Spotify' } };
  saveSessions();
  res.json({ ok: true });
});

function getDevMockSpotifyItems(rawQuery) {
  const q = String(rawQuery || '').toLowerCase().trim();
  const baseByArtist = {
    daft: [
      { title: 'One More Time', channel: 'Daft Punk' },
      { title: 'Get Lucky', channel: 'Daft Punk, Pharrell Williams' },
      { title: 'Harder, Better, Faster, Stronger', channel: 'Daft Punk' }
    ],
    weeknd: [
      { title: 'Blinding Lights', channel: 'The Weeknd' },
      { title: 'Starboy', channel: 'The Weeknd, Daft Punk' },
      { title: 'Save Your Tears', channel: 'The Weeknd' }
    ],
    drake: [
      { title: "God's Plan", channel: 'Drake' },
      { title: 'Hotline Bling', channel: 'Drake' },
      { title: 'One Dance', channel: 'Drake, Wizkid, Kyla' }
    ],
    miley: [
      { title: 'Flowers', channel: 'Miley Cyrus' },
      { title: 'Wrecking Ball', channel: 'Miley Cyrus' },
      { title: "Party In The U.S.A.", channel: 'Miley Cyrus' }
    ],
    'bad bunny': [
      { title: 'Tití Me Preguntó', channel: 'Bad Bunny' },
      { title: 'MONACO', channel: 'Bad Bunny' },
      { title: 'Moscow Mule', channel: 'Bad Bunny' }
    ]
  };
  const key = Object.keys(baseByArtist).find(k => q.includes(k));
  const picked = key ? baseByArtist[key] : [
    { title: 'Midnight City', channel: 'M83' },
    { title: 'Feel Good Inc.', channel: 'Gorillaz' },
    { title: 'Levitating', channel: 'Dua Lipa' }
  ];
  return picked.slice(0, 8).map((t, i) => ({
    id: `devmock_${(key || 'generic').replace(/\s+/g, '_')}_${i + 1}`,
    name: t.title,
    artists: [{ name: t.channel }],
    album: {
      images: [
        { url: `https://picsum.photos/seed/zpeed_sp_mock_${encodeURIComponent((key || 'generic') + '_' + i)}/640/640` }
      ]
    },
    uri: `spotify:track:devmock_${(key || 'generic').replace(/\s+/g, '_')}_${i + 1}`,
    isMock: true,
    duration_ms: (180 + i * 17) * 1000
  }));
}

function mapSpotifyItemsToTrackResults(items) {
  return items.map(t => ({
    id: t.id || t.spotifyId || null,
    platform: 'spotify',
    spotifyUri: t.uri,
    spotifyId: t.id,
    title: t.name,
    channel: Array.isArray(t.artists) ? t.artists.map(a => a.name).join(', ') : '',
    thumbnail: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || '',
    duration: `${Math.floor((t.duration_ms || 0) / 1000)}s`,
    isMock: !!t.isMock
  }));
}

// ─── Spotify search (uses HOST's token, called by guests) ───
app.get('/api/spotify/search', async (req, res) => {
  const { q, code } = req.query;
  if (useMockSpotify()) {
    if (process.env.USE_MOCK_SPOTIFY === 'true') {
      console.log('[SPOTIFY] search using mock (USE_MOCK_SPOTIFY=true)');
    }
    return res.json(mapSpotifyItemsToTrackResults(getDevMockSpotifyItems(q)));
  }
  const roomKey = resolveSessionKey(code);
  if (!roomKey) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'Missing or invalid session code.'
    });
  }
  const s = sessions[roomKey];
  if (!s) {
    return res.status(404).json({
      error: 'session_not_found',
      message: 'Unknown session code.'
    });
  }
  if (!s.hostSpotify?.tokens) {
    return res.status(401).json({
      error: 'spotify_not_connected',
      needSpotify: true,
      message: 'Spotify doit être reconnecté.'
    });
  }
  const ensure = await ensureSpotifyAccessToken(s, process.env, { roomKey, stage: 'search.ensure_token' });
  if (!ensure.ok) {
    spotifyDiag('spotify_search_token_invalid', {
      code: roomKey,
      query: q || '',
      status: ensure.status || 401,
      error: ensure.error,
      details: ensure.details || null
    });
    return spotifyEnsureFailure(res, ensure, 'search.ensure_token');
  }
  if (ensure.refreshed) saveSessions();
  try {
    const query = String(q || '');
    const shouldVerboseLog =
      query.toLowerCase().trim() === 'daft punk' || req.query.debug === '1';
    const r = await axios.get(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=6`,
      {
        headers: { Authorization: `Bearer ${s.hostSpotify.tokens.access_token}` },
        validateStatus: () => true
      }
    );
    if (shouldVerboseLog) {
      spotifyDiag('spotify_search_raw_response', {
        code: roomKey,
        query,
        status: r.status,
        rawResponse: r.data
      });
    }
    if (r.status === 401 || r.status === 403) {
      spotifyDiag('spotify_search_auth_error', {
        code: roomKey,
        status: r.status,
        query: q || '',
        responseError: r.data?.error || null
      });
      return spotifyApiFailure(res, r.status, 'search.fetch', {
        spotifyHttpStatus: r.status,
        spotifyError: r.data?.error || null
      });
    }
    if (r.status === 429) {
      console.log('[SPOTIFY] search rate-limited → mock results');
      return res.json(mapSpotifyItemsToTrackResults(getDevMockSpotifyItems(q)));
    }
    if (r.status !== 200) {
      spotifyDiag('spotify_search_non200', {
        code: roomKey,
        status: r.status,
        query: q || '',
        spotifyError: r.data?.error || null
      });
      return spotifyApiFailure(res, r.status || 502, 'search.fetch', {
        spotifyHttpStatus: r.status,
        spotifyError: r.data?.error || null
      });
    }
    if (!Array.isArray(r.data?.tracks?.items)) {
      spotifyDiag('spotify_search_unexpected_shape', {
        code: roomKey,
        query,
        status: r.status,
        rawResponse: r.data
      });
      return spotifyApiFailure(res, 502, 'search.parse', { message: 'Unexpected Spotify response shape' });
    }
    if (r.data.tracks.items.length === 0) {
      spotifyDiag('spotify_search_empty', {
        code: roomKey,
        query,
        status: r.status,
        rawResponse: r.data
      });
    }
    res.json(mapSpotifyItemsToTrackResults(r.data.tracks.items));
  } catch(e) {
    spotifyDiag('spotify_search_exception', {
      code: roomKey,
      query: q || '',
      error: e.response?.data || e.message
    });
    console.log('[SPOTIFY] fallback to mock');
    return res.json(mapSpotifyItemsToTrackResults(getDevMockSpotifyItems(q)));
  }
});

// ─── Check if Spotify is available for this session ───
app.get('/api/session/:code/platforms', (req, res) => {
  const s = sessions[req.params.code];
  if (!s) return res.status(404).json({});
  res.json({
    spotify: !!(s.hostSpotify?.tokens),
    youtube: true
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    lanIP: LAN_IP,
    port: PORT,
    publicBase: getRequestPublicBase(req),
    publicBaseFallback: PUBLIC_BASE,
    publicBaseSource: publicBaseSource()
  });
});

// ── DEBUG: socket rooms ──
app.get('/api/debug/rooms', async (req, res) => {
  const sockets = await io.fetchSockets();
  const rooms = {};
  sockets.forEach(s => { rooms[s.id] = [...s.rooms]; });
  res.json({ socketCount: sockets.length, rooms });
});

// ── TEST ENDPOINT: injecte des tracks dans une session ──
app.post('/api/test/inject', (req, res) => {
  const { code } = req.body;
  const s = sessions[code];
  if (!s) return res.status(404).json({ error: 'Session not found' });
  const tracks = [
    { id: uuidv4(), videoId:'v1', title:'Blinding Lights', channel:'The Weeknd', thumbnail:'https://img.youtube.com/vi/4NRXx6U8ABQ/mqdefault.jpg', votes:6, proposedBy:'Marc', voters:['g1','g2','g3','g4','g5','g6'], voterNames:['Marc','Julie','Thomas','Sophie','Lucas','Karim'], platform:'youtube' },
    { id: uuidv4(), videoId:'v2', title:'As It Was', channel:'Harry Styles', thumbnail:'https://img.youtube.com/vi/H5v3kku4y6Q/mqdefault.jpg', votes:3, proposedBy:'Julie', voters:['g1','g2','g3'], voterNames:['Marc','Thomas','Sophie'], platform:'youtube' },
    { id: uuidv4(), videoId:'v3', title:'Levitating', channel:'Dua Lipa', thumbnail:'https://img.youtube.com/vi/TUVcZfQe-Kw/mqdefault.jpg', votes:1, proposedBy:'Thomas', voters:['g1'], voterNames:['Marc'], platform:'youtube' },
  ];
  s.queue = tracks;
  io.to(`session:${code}`).emit('queue:update', { queue: s.queue });
  res.json({ ok: true, injected: tracks.length });
});

// ─────────────────────────────────────────────
// Spotify pipeline tick (5s — aligné retry device / consommation progressive)
// ─────────────────────────────────────────────
setInterval(() => {
  for (const code of Object.keys(sessions)) {
    const s = sessions[code];
    tickSpotifyPipeline({
      session: s,
      code,
      io,
      processEnv: process.env,
      saveSessions
    }).catch(err => console.warn('[spotify tick]', code, err.message));
  }
}, 5000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 ZPEED running on http://localhost:${PORT}`);
  console.log(`📱 Sur le réseau local : http://${LAN_IP}:${PORT}\n`);
  console.log('[ZPEED] boot env (values hidden):', {
    SPOTIFY_CLIENT_ID: !!process.env.SPOTIFY_CLIENT_ID,
    SPOTIFY_CLIENT_SECRET: !!process.env.SPOTIFY_CLIENT_SECRET,
    SPOTIFY_REDIRECT_URI_env: !!process.env.SPOTIFY_REDIRECT_URI,
    PUBLIC_APP_URL: !!process.env.PUBLIC_APP_URL,
    PUBLIC_URL: !!process.env.PUBLIC_URL,
    ZPEED_PUBLIC_URL: !!process.env.ZPEED_PUBLIC_URL,
    REDIRECT_BASE: !!process.env.REDIRECT_BASE,
    RENDER_EXTERNAL_URL: !!process.env.RENDER_EXTERNAL_URL,
    RENDER_GIT_COMMIT: !!process.env.RENDER_GIT_COMMIT,
    USE_MOCK_SPOTIFY: process.env.USE_MOCK_SPOTIFY === 'true',
    spotifyRedirectSource: spotifyRedirectSource(),
    spotifyCallbackUrl: SPOTIFY_REDIRECT,
    publicBaseSource: publicBaseSource(),
    publicBase: PUBLIC_BASE
  });
});
