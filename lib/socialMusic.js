/**
 * Contextual social music: canonical genres, track→genre mapping, profiles, group vibe.
 * Deterministic, no ML — used by server.js taste persistence.
 */

const GENRE_BUCKETS = ['electro', 'hiphop', 'jazz', 'pop', 'rock', 'chill'];

/** Old taste keys → canonical bucket */
const LEGACY_GENRE_TO_BUCKET = {
  afro: 'hiphop',
  rap: 'hiphop',
  rnb: 'pop',
  latin: 'pop',
  reggaeton: 'pop'
};

const FRENCH_LABEL = {
  electro: 'Électro',
  hiphop: 'Hip-hop',
  jazz: 'Jazz',
  pop: 'Pop',
  rock: 'Rock',
  chill: 'Chill',
  mix: 'Mix'
};

/** Spotify-style genre strings → bucket */
const SPOTIFY_GENRE_TO_BUCKET = [
  { bucket: 'electro', patterns: ['electro', 'house', 'techno', 'edm', 'dance', 'trance', 'dubstep', 'club'] },
  { bucket: 'hiphop', patterns: ['hip hop', 'hip-hop', 'rap', 'trap', 'grime', 'drill', 'r&b', 'rnb', 'urban'] },
  { bucket: 'jazz', patterns: ['jazz', 'swing', 'bebop', 'bossa', 'fusion jazz', 'smooth jazz'] },
  { bucket: 'pop', patterns: ['pop', 'dance-pop', 'synth-pop', 'k-pop', 'latin pop'] },
  { bucket: 'rock', patterns: ['rock', 'metal', 'punk', 'indie', 'alternative', 'grunge', 'hard rock'] },
  { bucket: 'chill', patterns: ['chill', 'ambient', 'lo-fi', 'lofi', 'acoustic', 'easy listening', 'downtempo'] }
];

/** Artist / title keyword hints → bucket (when Spotify genres absent) */
const ARTIST_KEYWORD_RULES = [
  { bucket: 'electro', keywords: ['daft punk', 'deadmau5', 'skrillex', 'calvin harris', 'david guetta', 'disclosure', 'fred again'] },
  { bucket: 'hiphop', keywords: ['drake', 'kendrick', 'travis', 'booba', 'ninho', 'pnl', 'jay-z', 'eminem', 'cardi b', 'migos'] },
  { bucket: 'jazz', keywords: ['miles davis', 'coltrane', 'herbie', 'norah jones', 'diana krall'] },
  { bucket: 'rock', keywords: ['coldplay', 'arctic monkeys', 'nirvana', 'foo fighters', 'queen', 'led zeppelin', 'radiohead'] },
  { bucket: 'chill', keywords: ['chill', 'lofi', 'lo-fi', 'ambient', 'acoustic'] },
  { bucket: 'pop', keywords: ['taylor swift', 'dua lipa', 'weeknd', 'harry styles', 'adele', 'billie eilish', 'ariana'] }
];

function emptyGenreCounts() {
  const o = {};
  for (const g of GENRE_BUCKETS) o[g] = 0;
  return o;
}

function normalizeSpotifyGenresToBuckets(rawList) {
  if (!Array.isArray(rawList) || !rawList.length) return null;
  const scores = emptyGenreCounts();
  for (const raw of rawList) {
    const s = String(raw || '').toLowerCase().trim();
    if (!s) continue;
    let hit = false;
    for (const { bucket, patterns } of SPOTIFY_GENRE_TO_BUCKET) {
      if (patterns.some(p => s.includes(p))) {
        scores[bucket] += 2;
        hit = true;
        break;
      }
    }
    if (!hit) {
      for (const b of GENRE_BUCKETS) {
        if (s.includes(b)) {
          scores[b] += 1;
          hit = true;
          break;
        }
      }
    }
  }
  const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] > 0) return top[0];
  return null;
}

function mapArtistTextToBucket(text) {
  const t = String(text || '').toLowerCase();
  for (const { bucket, keywords } of ARTIST_KEYWORD_RULES) {
    if (keywords.some(k => t.includes(k))) return bucket;
  }
  return null;
}

/**
 * Single canonical genre for a track (for counts + interactions).
 * @param {object} track
 * @returns {string} one of GENRE_BUCKETS
 */
function mapTrackToGenre(track) {
  const fromSpotify = normalizeSpotifyGenresToBuckets(track?.genres);
  if (fromSpotify) return fromSpotify;

  const text = `${track?.title || ''} ${track?.channel || ''} ${track?.artist || ''}`.toLowerCase();
  const fromKeywords = mapArtistTextToBucket(text);
  if (fromKeywords) return fromKeywords;

  return 'pop';
}

function migrateProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const uid = profile.userId || 'unknown';
  const genreCounts = emptyGenreCounts();
  if (profile.genreCounts && typeof profile.genreCounts === 'object') {
    for (const g of GENRE_BUCKETS) {
      genreCounts[g] = Math.max(0, Number(profile.genreCounts[g]) || 0);
    }
  } else if (profile.interactedGenres || profile.genreSignals) {
    const legacy = { ...(profile.interactedGenres || {}), ...(profile.genreSignals || {}) };
    for (const [k, v] of Object.entries(legacy)) {
      const key = String(k).toLowerCase();
      let bucket = GENRE_BUCKETS.find(b => b === key);
      if (!bucket) bucket = LEGACY_GENRE_TO_BUCKET[key];
      if (!bucket) {
        bucket =
          SPOTIFY_GENRE_TO_BUCKET.find(({ patterns }) => patterns.some(p => key.includes(p)))?.bucket ||
          mapArtistTextToBucket(key) ||
          'pop';
      }
      genreCounts[bucket] += Math.max(0, Math.round(Number(v) || 0));
    }
  }

  return {
    userId: uid,
    genreCounts,
    likes: Math.max(0, Number(profile.likes) || 0),
    skips: Math.max(0, Number(profile.skips) || 0),
    playCompletion: Math.max(0, Number(profile.playCompletion) || 0),
    topGenres: Array.isArray(profile.topGenres) ? profile.topGenres.slice(0, 2) : [],
    interactions: Array.isArray(profile.interactions) ? profile.interactions.slice(-60) : [],
    updatedAt: profile.updatedAt || new Date().toISOString()
  };
}

function deriveTopGenres(genreCounts) {
  return Object.entries(genreCounts || {})
    .filter(([g]) => GENRE_BUCKETS.includes(g))
    .sort((a, b) => b[1] - a[1])
    .filter(([, n]) => n > 0)
    .slice(0, 2)
    .map(([g]) => g);
}

function appendInteraction(profile, { trackId, genre, action, ts }) {
  if (!profile.interactions) profile.interactions = [];
  profile.interactions.push({
    userId: profile.userId,
    trackId: String(trackId || ''),
    genre,
    action,
    ts: ts || new Date().toISOString()
  });
  if (profile.interactions.length > 80) profile.interactions = profile.interactions.slice(-80);
}

/**
 * Update profile on taste write. Recomputes topGenres.
 */
function applyTasteAction(profile, track, action, trackId) {
  const genre = mapTrackToGenre(track);
  if (action === 'add') {
    profile.genreCounts[genre] = (profile.genreCounts[genre] || 0) + 2;
  } else if (action === 'like') {
    profile.likes = (profile.likes || 0) + 1;
    profile.genreCounts[genre] = (profile.genreCounts[genre] || 0) + 1;
  } else if (action === 'skip') {
    profile.skips = (profile.skips || 0) + 1;
    profile.genreCounts[genre] = Math.max(0, (profile.genreCounts[genre] || 0) - 1);
  } else if (action === 'play') {
    profile.playCompletion = (profile.playCompletion || 0) + 1;
    profile.genreCounts[genre] = (profile.genreCounts[genre] || 0) + 1;
  }
  profile.topGenres = deriveTopGenres(profile.genreCounts);
  appendInteraction(profile, { trackId, genre, action, ts: new Date().toISOString() });
  profile.updatedAt = new Date().toISOString();
}

function normalizeVector(counts) {
  const vec = emptyGenreCounts();
  for (const g of GENRE_BUCKETS) vec[g] = Math.max(0, Number(counts[g]) || 0);
  let sum = 0;
  for (const g of GENRE_BUCKETS) sum += vec[g];
  if (sum <= 0) return null;
  for (const g of GENRE_BUCKETS) vec[g] /= sum;
  return vec;
}

function mergeWeightedAverage(activeUserIds, tasteProfiles) {
  const merged = emptyGenreCounts();
  const ids = (activeUserIds || []).filter(Boolean);
  if (!ids.length) return merged;

  let parts = 0;
  for (const uid of ids) {
    const p = tasteProfiles[uid];
    if (!p || !p.genreCounts) continue;
    const norm = normalizeVector(p.genreCounts);
    if (!norm) continue;
    parts += 1;
    for (const g of GENRE_BUCKETS) merged[g] += norm[g];
  }
  if (parts > 0) {
    for (const g of GENRE_BUCKETS) merged[g] /= parts;
  }
  return merged;
}

function pushTrackTasteWindow(session, trackId, genre) {
  if (!session._trackTasteWindow) session._trackTasteWindow = [];
  const id = String(trackId || '');
  let row = session._trackTasteWindow.find(r => r.trackId === id);
  if (!row) {
    row = { trackId: id, genre, likes: 0, skips: 0 };
    session._trackTasteWindow.push(row);
    while (session._trackTasteWindow.length > 3) session._trackTasteWindow.shift();
  }
  return row;
}

function recordSwipeOnWindow(session, trackId, genre, direction) {
  const row = pushTrackTasteWindow(session, trackId, genre);
  if (direction === 'like') row.likes += 1;
  else if (direction === 'skip') row.skips += 1;
}

function realtimeGenreBoost(session) {
  const boost = emptyGenreCounts();
  const w = session._trackTasteWindow || [];
  for (const row of w) {
    const g = row.genre && GENRE_BUCKETS.includes(row.genre) ? row.genre : 'pop';
    const delta = (Number(row.likes) || 0) * 0.18 - (Number(row.skips) || 0) * 0.14;
    boost[g] += delta;
  }
  return boost;
}

function topTwoFromScores(scores) {
  return Object.entries(scores)
    .filter(([g]) => GENRE_BUCKETS.includes(g))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([g]) => g);
}

/**
 * Full session vibe: merged active profiles + last-3-tracks signal.
 * Mutates session.sessionVibe, session.sessionVibeGenres, session.sessionVibeLabels
 */
function computeFullSessionVibe(session, tasteProfiles) {
  const activeUserIds = Object.keys(session._activeUsers || {});
  const base = mergeWeightedAverage(activeUserIds, tasteProfiles);
  const rt = realtimeGenreBoost(session);
  const combined = emptyGenreCounts();
  for (const g of GENRE_BUCKETS) {
    combined[g] = (base[g] || 0) * 0.82 + (rt[g] || 0);
  }
  const top = topTwoFromScores(combined).filter(g => combined[g] > 0);
  session.sessionVibeGenres = top.length ? top : [];
  session.sessionVibeKey = top.length ? top.join('+') : 'mix';
  session.sessionVibeLabels = top.length ? top.map(g => FRENCH_LABEL[g] || g) : [FRENCH_LABEL.mix];
  session.sessionVibe = session.sessionVibeLabels.join(' · ');
  return {
    sessionVibe: session.sessionVibe,
    sessionVibeGenres: session.sessionVibeGenres,
    sessionVibeLabels: session.sessionVibeLabels
  };
}

function isAutoDjTrack(t) {
  return !!(t && (t.autoDJ === true || t.aiSuggested === true));
}

function searchQueriesForVibe(session) {
  const keys = Array.isArray(session.sessionVibeGenres) ? session.sessionVibeGenres.filter(Boolean) : [];
  const q = [];
  for (const g of keys) {
    if (g === 'hiphop') q.push('hip hop rap hits', 'rap français hits');
    else if (g === 'electro') q.push('electronic dance hits', 'house music hits');
    else if (g === 'jazz') q.push('jazz classics', 'smooth jazz playlist');
    else if (g === 'rock') q.push('rock classics', 'indie rock hits');
    else if (g === 'chill') q.push('chill vibes playlist', 'lofi chill');
    else q.push(`${g} hits`);
  }
  if (!q.length) return ['party music mix', 'feel good pop hits'];
  return q;
}

module.exports = {
  GENRE_BUCKETS,
  FRENCH_LABEL,
  mapTrackToGenre,
  emptyGenreCounts,
  migrateProfile,
  deriveTopGenres,
  applyTasteAction,
  appendInteraction,
  computeFullSessionVibe,
  recordSwipeOnWindow,
  isAutoDjTrack,
  searchQueriesForVibe
};
