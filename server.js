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
// Public base URL: Render injects RENDER_EXTERNAL_URL automatically
const PUBLIC_BASE = process.env.RENDER_EXTERNAL_URL
  ? process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '')
  : `http://${LAN_IP}:${PORT}`;

const app = express();
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
const REDIRECT_BASE = process.env.REDIRECT_BASE || 'http://127.0.0.1:3000';

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
  const s = sessions[code];
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
const SPOTIFY_REDIRECT = `${process.env.REDIRECT_BASE || 'http://127.0.0.1:3000'}/auth/spotify/callback`;

const spotifyApi = new SpotifyWebApi({
  clientId:     process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri:  SPOTIFY_REDIRECT
});

app.get('/auth/spotify', (req, res) => {
  const { sessionCode } = req.query;
  const scopes = ['user-read-private', 'user-read-email', 'playlist-read-private', 'playlist-read-collaborative', 'streaming', 'user-modify-playback-state', 'user-read-playback-state'];
  const url = spotifyApi.createAuthorizeURL(scopes, sessionCode || '');
  res.redirect(url);
});

app.get('/auth/spotify/callback', async (req, res) => {
  const { code: authCode, state } = req.query;
  console.log('Spotify callback hit — authCode:', authCode ? authCode.substring(0,20)+'...' : 'MISSING', '| state:', state);
  try {
    // Manual token exchange to see exact Spotify error
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
    console.log('Spotify token exchange SUCCESS:', tokenRes.status);
    const { access_token, refresh_token } = tokenRes.data;
    spotifyApi.setAccessToken(access_token);
    const me = await spotifyApi.getMe();

    if (state && sessions[state]) {
      sessions[state].hostSpotify = {
        tokens: { access_token, refresh_token },
        profile: { name: me.body.display_name, picture: me.body.images?.[0]?.url, email: me.body.email }
      };
    }
    return res.redirect(`/host.html?code=${state}&platform=spotify`);
  } catch (err) {
    const errData = err.response?.data || err.message;
    console.error('Spotify token exchange FAILED:', JSON.stringify(errData, null, 2));
    res.redirect('/host.html?error=spotify_failed');
  }
});

app.get('/api/spotify/playlists', async (req, res) => {
  const { code } = req.query;
  const s = sessions[code];
  if (!s?.hostSpotify?.tokens) return res.status(401).json({ error: 'Not connected' });
  spotifyApi.setAccessToken(s.hostSpotify.tokens.access_token);
  const data = await spotifyApi.getUserPlaylists({ limit: 20 });
  res.json(data.body.items.map(p => ({
    id: p.id, title: p.name,
    thumbnail: p.images?.[0]?.url,
    count: p.tracks?.total
  })));
});

app.get('/api/spotify/playlist/:id', async (req, res) => {
  const { code } = req.query;
  const s = sessions[code];
  if (!s?.hostSpotify?.tokens) return res.status(401).json({ error: 'Not connected' });
  spotifyApi.setAccessToken(s.hostSpotify.tokens.access_token);
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
          sessions[code] = s;
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
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
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
  const code = Math.random().toString(36).substring(2, 6).toUpperCase();
  const hostId = uuidv4();

  sessions[code] = {
    code, hostId,
    hostName: userName || 'Host',
    speakerName,
    speakerId: key,
    guestCount: 0,
    queue: [],
    currentTrack: null,
    guests: [],
    hostGoogle: null,
    createdAt: new Date()
  };

  // Lier l'enceinte à cette session
  speakerSessions[key] = code;

  const joinUrl = `http://localhost:3000?speaker=${encodeURIComponent(speakerName)}&speakerId=${key}`;
  const qrDataUrl = await QRCode.toDataURL(joinUrl, {
    color: { dark: '#7B52D4', light: '#1a1a1a' },
    width: 300, margin: 2
  });

  res.json({
    role: 'host',
    code,
    hostId,
    qrDataUrl,
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
  const { hostName } = req.body;
  const code = Math.random().toString(36).substring(2, 6).toUpperCase();
  const hostId = uuidv4();

  sessions[code] = {
    code, hostId,
    hostName: hostName || 'Host',
    guestCount: 0,
    queue: [],
    currentTrack: null,
    guests: [],
    hostGoogle: null,
    createdAt: new Date()
  };
  saveSessions();

  const joinUrl = `${PUBLIC_BASE}/?code=${code}`;
  const qrDataUrl = await QRCode.toDataURL(joinUrl, {
    color: { dark: '#7B52D4', light: '#1a1a1a' },
    width: 300, margin: 2
  });
  // Raw matrix for live canvas rendering
  const qrObj = QRCode.create(joinUrl, { errorCorrectionLevel: 'M' });
  const qrMatrix = Array.from(qrObj.modules.data);
  const qrSize   = qrObj.modules.size;

  res.json({ success: true, code, hostId, qrDataUrl, joinUrl, lanIP: LAN_IP, qrMatrix, qrSize });
});

app.post('/api/session/join', (req, res) => {
  const { code, guestName } = req.body;
  const session = sessions[code];
  if (!session) return res.status(404).json({ success: false, message: 'Session introuvable' });

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
    queue: session.queue,
    currentTrack: session.currentTrack,
    googleConnected: !!(session.hostGoogle)
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

  socket.on('host:join', ({ code, hostId }) => {
    if (!sessions[code]) return;
    socket.join(`session:${code}`);
    socket.sessionCode = code;
    socket.role = 'host';
  });

  socket.on('guest:join', ({ code, guestId, guestName }) => {
    if (!sessions[code]) return;
    socket.join(`session:${code}`);
    socket.sessionCode = code;
    socket.role = 'guest';
    socket.guestId = guestId;
    socket.guestName = guestName;
    // Needed for targeted AI roast delivery
    socket.data.guestId = guestId;
    socket.data.code = code;

    io.to(`session:${code}`).emit('session:update', {
      guestCount: sessions[code].guestCount,
      guestList:  sessions[code].guests,
      queue: sessions[code].queue
    });

    io.to(`session:${code}`).emit('notification', {
      message: `🎉 ${guestName} a rejoint la session !`
    });
  });

  socket.on('track:propose', ({ code, guestId, guestName, userName, track }) => {
    const s = sessions[code];
    if (!s) return;
    const name = guestName || userName || 'Anonyme';
    const trackId = uuidv4();
    const newTrack = { id: trackId, ...track, votes: 1, proposedBy: name, voters: [guestId || 'host'] };
    s.queue.push(newTrack);
    s.queue.sort((a, b) => b.votes - a.votes);
    saveSessions();
    io.to(`session:${code}`).emit('queue:update', { queue: s.queue });
    io.to(`session:${code}`).emit('notification', { message: `🎵 ${name} a proposé "${track.title}"` });
    // 🔥 Roast — si 0 vote après 45 secondes (en dehors du vote auto du proposeur)
    setTimeout(() => {
      const sess = sessions[code];
      if (!sess) return;
      const t = sess.queue.find(q => q.id === trackId);
      // votes = 1 = seulement le proposeur lui-même, personne d'autre n'a voté
      if (t && t.votes <= 1) {
        aiRoast(name, track.title, track.artist).then(roast => {
          if (roast) {
            // Envoyer au socket du proposeur (ou broadcast si pas trouvé)
            const targetSocket = [...io.sockets.sockets.values()].find(
              sk => sk.data && sk.data.guestId === guestId && sk.data.code === code
            );
            if (targetSocket) {
              targetSocket.emit('ai:roast', { roast, trackId });
            } else {
              // Fallback: broadcast à la session avec guestId pour filtrage côté client
              io.to(`session:${code}`).emit('ai:roast', { roast, trackId, guestId });
            }
          }
        });
      }
    }, 45 * 1000);
  });

  socket.on('track:vote', ({ code, trackId, guestId, guestName, userName, vote }) => {
    const s = sessions[code];
    if (!s) return;
    const track = s.queue.find(t => t.id === trackId);
    if (!track || track.voters.includes(guestId)) return;
    track.votes += vote;
    track.voters.push(guestId);
    // Stocker noms des votants pour les avatars
    if (!track.voterNames) track.voterNames = [];
    const name = guestName || userName || 'Someone';
    if (!track.voterNames.includes(name)) track.voterNames.push(name);
    s.queue.sort((a, b) => b.votes - a.votes);
    io.to(`session:${code}`).emit('queue:update', { queue: s.queue });
    // Broadcaster l'event vote aux autres users (connivence)
    if (vote > 0) {
      io.to(`session:${code}`).emit('track:voted', {
        trackId,
        voterName: name,
        initials: name.substring(0, 2).toUpperCase(),
        votes: track.votes
      });
    }
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
    const s = sessions[code];
    if (!s) return;
    const track = s.queue.find(t => t.id === trackId);
    if (!track) return;
    s.currentTrack = track;
    s.queue = s.queue.filter(t => t.id !== trackId);
    io.to(`session:${code}`).emit('track:playing', { track });
    io.to(`session:${code}`).emit('queue:update', { queue: s.queue });
    // 🎤 AI DJ — commentaire async
    aiDJComment(track.title, track.artist).then(comment => {
      if (comment) io.to(`session:${code}`).emit('ai:dj_comment', { comment, track });
    });
  });

  socket.on('track:skip', ({ code }) => {
    const s = sessions[code];
    if (!s) return;
    if (s.queue.length > 0) {
      const next = s.queue.shift();
      s.currentTrack = next;
      io.to(`session:${code}`).emit('track:playing', { track: next });
      io.to(`session:${code}`).emit('queue:update', { queue: s.queue });
    } else {
      s.currentTrack = null;
      io.to(`session:${code}`).emit('track:playing', { track: null });
    }
  });

  // Host ends the session
  socket.on('session:end', ({ code }) => {
    const s = sessions[code];
    if (!s) return;
    io.to(`session:${code}`).emit('session:ended', {});
    delete sessions[code];
    saveSessions();
  });

  // Host adds a track from their playlist directly
  socket.on('track:add_from_playlist', ({ code, track }) => {
    const s = sessions[code];
    if (!s) return;
    const newTrack = { id: uuidv4(), ...track, votes: 0, proposedBy: '🎧 Host', voters: [] };
    s.queue.push(newTrack);
    io.to(`session:${code}`).emit('queue:update', { queue: s.queue });
    io.to(`session:${code}`).emit('notification', { message: `🎧 Host a ajouté "${track.title}"` });
  });
});

// ─────────────────────────────────────────────
// CONFIG ENDPOINT (for frontend to know LAN IP)
// ─────────────────────────────────────────────
// ─── Spotify token proxy (for Web Playback SDK in host browser) ───
app.get('/api/spotify/token', (req, res) => {
  const { code } = req.query;
  const s = sessions[code];
  if (!s?.hostSpotify?.tokens) return res.status(401).json({ error: 'Not connected' });
  res.json({ access_token: s.hostSpotify.tokens.access_token });
});

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

// ─── Spotify search (uses HOST's token, called by guests) ───
app.get('/api/spotify/search', async (req, res) => {
  const { q, code } = req.query;
  const s = sessions[code];
  if (!s?.hostSpotify?.tokens) return res.status(401).json({ error: 'Not connected' });
  try {
    const r = await axios.get(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=6`,
      { headers: { Authorization: `Bearer ${s.hostSpotify.tokens.access_token}` } }
    );
    res.json(r.data.tracks.items.map(t => ({
      platform: 'spotify',
      spotifyUri: t.uri,
      spotifyId: t.id,
      title: t.name,
      channel: t.artists.map(a => a.name).join(', '),
      thumbnail: t.album.images[1]?.url || t.album.images[0]?.url || '',
      duration: Math.floor(t.duration_ms / 1000) + 's'
    })));
  } catch(e) {
    res.status(500).json([]);
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
  res.json({ lanIP: LAN_IP, port: PORT, publicBase: PUBLIC_BASE });
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
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 ZPEED running on http://localhost:${PORT}`);
  console.log(`📱 Sur le réseau local : http://${LAN_IP}:${PORT}\n`);
});
