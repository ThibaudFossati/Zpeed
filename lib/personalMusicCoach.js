/**
 * Agentic Personal Music Coach — deterministic MVP (no ML).
 * Suggestions are opt-in add only; data stays SONDER-internal (taste + session).
 */

const social = require('./socialMusic');
const userSocial = require('./userSocialProfile');

function normTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function collectExcluded(session) {
  const ids = new Set();
  const titles = new Set();
  for (const t of session.queue || []) {
    const id = t.youtubeId || t.videoId;
    if (id) ids.add(String(id));
    if (t.title) titles.add(normTitle(t.title));
  }
  const cur = session.currentTrack;
  if (cur) {
    const id = cur.youtubeId || cur.videoId;
    if (id) ids.add(String(id));
    if (cur.title) titles.add(normTitle(cur.title));
  }
  for (const row of session.playHistory || []) {
    if (row.key && String(row.key).includes('youtube')) {
      /* optional */
    }
    if (row.title) titles.add(normTitle(row.title));
  }
  return { ids, titles };
}

function genreBucketSet(session) {
  const set = new Set();
  for (const t of session.queue || []) {
    const g = t.primaryGenre || social.mapTrackToGenre(t);
    if (g) set.add(g);
  }
  return set;
}

function queueNetEnergy(session) {
  let sum = 0;
  for (const t of session.queue || []) {
    sum += (Number(t.likes) || 0) - (Number(t.skips) || 0);
  }
  return sum;
}

function recentWindowSignal(session) {
  const w = session._trackTasteWindow || [];
  let likes = 0;
  let skips = 0;
  for (const row of w) {
    likes += Number(row.likes) || 0;
    skips += Number(row.skips) || 0;
  }
  return { likes, skips, balance: likes - skips };
}

function intersectUserSessionVibe(userTopBuckets, sessionGenres) {
  const sg = (sessionGenres || []).filter(g => social.GENRE_BUCKETS.includes(g));
  const hit = userTopBuckets.filter(g => sg.includes(g));
  return { intersection: hit, sessionOnly: sg[0] || null, userFirst: userTopBuckets[0] || null };
}

/**
 * @returns {string} short positive French reason
 */
function explainSuggestion({ mode }) {
  switch (mode) {
    case 'intersection':
      return 'Ton style + l’ambiance actuelle';
    case 'vibe_fit':
      return 'Parfait pour la vibe du moment';
    case 'energy_lift':
      return 'Un boost pour la danse';
    case 'stabilize':
      return 'Une base solide pour la file';
    case 'discovery':
      return 'Une pépite qui suit la soirée';
    case 'safe_starter':
      return 'Un classique qui lance bien';
    case 'smooth':
      return 'Une belle transition';
    default:
      return 'Aligné avec la soirée';
  }
}

function roleHeuristic(roleLabel) {
  const r = String(roleLabel || '').toLowerCase();
  if (r.includes('party') || r.includes('boosteur') || r.includes('dancefloor')) return 'booster';
  if (r.includes('curateur') || r.includes('architecte')) return 'curator';
  if (r.includes('découvreur') || r.includes('pepite')) return 'discoverer';
  if (r.includes('chill') || r.includes('passionné')) return 'smooth';
  return 'neutral';
}

function buildSearchQueries(session, bucket, roleMode, signals) {
  const baseList = social.searchQueriesForVibe(session);
  const primary = baseList[0] || `${bucket} hits feel good`;
  const out = [];
  const bq =
    bucket === 'electro'
      ? 'electronic dance party hits'
      : bucket === 'hiphop'
        ? 'hip hop party hits'
        : bucket === 'rock'
          ? 'rock party anthems'
          : bucket === 'jazz'
            ? 'smooth jazz upbeat'
            : bucket === 'chill'
              ? 'chill house vibes party'
              : 'pop party hits';

  if (signals.queueEmpty) {
    out.push(`${bq} starter`, `${primary} crowd`);
  }
  if (signals.lowEnergy) {
    out.push(`${bucket} high energy dance mix`, `${primary} upbeat`);
  }
  if (signals.chaotic) {
    out.push(`${bucket} classic hits everyone knows`, `${primary} iconic`);
  }
  if (roleMode === 'booster') {
    out.push(`${primary} hype`, `${bq} energy`);
  } else if (roleMode === 'discoverer') {
    out.push(`${bucket} hidden gems indie`, `${primary} underrated`);
  } else if (roleMode === 'curator' || roleMode === 'smooth') {
    out.push(`${primary} smooth transition`, `${bucket} melodic mix`);
  }

  out.push(primary, bq, `${bucket} music mix party`);

  const seen = new Set();
  const uniq = [];
  for (const q of out) {
    const k = String(q || '').trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    uniq.push(String(q).trim());
  }
  return uniq.slice(0, 10);
}

function scoreResult(track, bucket, sessionGenres) {
  const g = social.mapTrackToGenre({
    title: track.title,
    channel: track.channel,
    genres: track.genres || []
  });
  let s = 0;
  if (g === bucket) s += 4;
  if (sessionGenres && sessionGenres.includes(g)) s += 2;
  const text = `${track.title} ${track.channel}`.toLowerCase();
  if (bucket === 'electro' && /remix|club|dance|house|edm/i.test(text)) s += 1;
  if (bucket === 'hiphop' && /rap|hip|trap/i.test(text)) s += 1;
  return s;
}

function computeConfidenceVibeMatch({ hasIntersection, netEnergy, vibeMatchBase }) {
  const confidence = Math.min(0.94, Math.max(0.56, 0.62 + (hasIntersection ? 0.14 : 0) + (netEnergy >= -1 ? 0.06 : 0)));
  const vibeMatch = Math.min(1, Math.max(0.35, vibeMatchBase));
  return { confidence, vibeMatch };
}

/**
 * @param {string} userId
 * @param {string} guestId
 * @param {object} session
 * @param {object} tasteProfiles
 * @param {object} socialProfiles
 * @param {*} YouTube sr default export
 */
async function computePersonalSuggestion(userId, guestId, session, tasteProfiles, socialProfiles, YouTube) {
  const uid = String(userId || '').trim();
  const taste = uid ? tasteProfiles[uid] : null;
  const rawRow = uid && socialProfiles[uid] ? socialProfiles[uid] : {};
  const roleLabel = userSocial.pickRoleLabel({
    sessionsHosted: Number(rawRow.sessionsHosted) || 0,
    likesReceived: Number(rawRow.likesReceived) || 0,
    tracksAdded: Number(rawRow.tracksAdded) || 0,
    tracksPlayed: Number(rawRow.tracksPlayed) || 0,
    sessionsJoined: Number(rawRow.sessionsJoined) || 0
  });
  const roleMode = roleHeuristic(roleLabel);

  const userTop = social.deriveTopGenres(taste?.genreCounts || social.emptyGenreCounts()).slice(0, 3);
  const sessionGenres = Array.isArray(session.sessionVibeGenres) ? session.sessionVibeGenres.filter(Boolean) : [];
  const { intersection, sessionOnly, userFirst } = intersectUserSessionVibe(userTop, sessionGenres);
  let bucket = intersection[0] || sessionOnly || userFirst || 'pop';
  if (!social.GENRE_BUCKETS.includes(bucket)) bucket = 'pop';

  let reasonMode = intersection.length ? 'intersection' : 'vibe_fit';
  const qLen = (session.queue || []).length;
  const gset = genreBucketSet(session);
  const chaotic = gset.size >= 4 && qLen >= 3;
  const net = queueNetEnergy(session);
  const win = recentWindowSignal(session);
  const lowEnergy = qLen >= 2 && net <= 0 && win.balance <= 0;
  const queueEmpty = qLen === 0;

  if (queueEmpty) reasonMode = 'safe_starter';
  else if (lowEnergy) reasonMode = 'energy_lift';
  else if (chaotic) reasonMode = 'stabilize';
  else if (roleMode === 'discoverer') reasonMode = 'discovery';
  else if (roleMode === 'smooth' || roleMode === 'curator') reasonMode = 'smooth';

  const signals = { queueEmpty, lowEnergy, chaotic, net, recent: win };
  const queries = buildSearchQueries(session, bucket, roleMode, signals);
  const ex = collectExcluded(session);

  let best = null;
  let bestScore = -1;
  for (const q of queries) {
    let results = [];
    try {
      results = await YouTube.search(q, { limit: 8, type: 'video' });
    } catch (_) {
      results = [];
    }
    for (const v of results) {
      const videoId = v.id;
      const title = v.title || '';
      const channel = v.channel?.name || 'YouTube';
      if (!videoId) continue;
      if (ex.ids.has(String(videoId))) continue;
      const nt = normTitle(title);
      if (nt && ex.titles.has(nt)) continue;
      const track = {
        videoId,
        youtubeId: videoId,
        title,
        channel,
        thumbnail: v.thumbnail?.url || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
        duration: v.durationFormatted || '',
        platform: 'youtube',
        genres: []
      };
      const sc = scoreResult(track, bucket, sessionGenres);
      if (sc > bestScore) {
        bestScore = sc;
        best = track;
      }
    }
    if (best && bestScore >= 4) break;
  }

  if (!best) return null;

  const hasIntersection = intersection.length > 0;
  const vibeMatchBase =
    hasIntersection * 0.45 +
    (sessionGenres.includes(social.mapTrackToGenre(best)) ? 0.35 : 0.2) +
    Math.min(0.2, (taste?.likes || 0) * 0.01);
  const { confidence, vibeMatch } = computeConfidenceVibeMatch({
    hasIntersection,
    netEnergy: net,
    vibeMatchBase
  });

  return {
    ok: true,
    track: best,
    reason: explainSuggestion({ mode: reasonMode }),
    confidence: Math.round(confidence * 100) / 100,
    vibeMatch: Math.round(vibeMatch * 100) / 100
  };
}

module.exports = {
  computePersonalSuggestion,
  explainSuggestion
};
