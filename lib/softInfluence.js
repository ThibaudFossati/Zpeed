/**
 * Soft influence: internal score only — shapes queue priority gently, no public ranking.
 */

const social = require('./socialMusic');

function readLikesReceived(socialProfiles, userId) {
  const u = String(userId || '').trim();
  if (!u || !socialProfiles || !socialProfiles[u]) return 0;
  return Math.max(0, Number(socialProfiles[u].likesReceived) || 0);
}

function readPlayCompletion(tasteProfiles, userId) {
  const u = String(userId || '').trim();
  if (!u || !tasteProfiles || !tasteProfiles[u]) return 0;
  return Math.max(0, Number(tasteProfiles[u].playCompletion) || 0);
}

/**
 * How aligned the user's taste is with the current session vibe (0..1).
 */
function vibeConsistencyScore(tasteProfile, session) {
  const sessionGenres = Array.isArray(session.sessionVibeGenres) ? session.sessionVibeGenres.filter(Boolean) : [];
  const counts = tasteProfile && tasteProfile.genreCounts ? tasteProfile.genreCounts : social.emptyGenreCounts();
  let total = 0;
  for (const g of social.GENRE_BUCKETS) {
    total += Math.max(0, Number(counts[g]) || 0);
  }
  if (total <= 0) {
    return sessionGenres.length ? 0.28 : 0.22;
  }
  let aligned = 0;
  for (const g of sessionGenres) {
    if (social.GENRE_BUCKETS.includes(g)) aligned += Math.max(0, Number(counts[g]) || 0);
  }
  const ratio = aligned / total;
  return Math.max(0.1, Math.min(1, ratio * 1.35 + 0.12));
}

/**
 * Internal 0..12 — never sent to clients as a standalone metric.
 */
function computeInfluenceScore(userId, session, tasteProfiles, socialProfiles) {
  const uid = String(userId || '').trim();
  if (!uid) return 0;
  const taste = tasteProfiles[uid] || null;
  const lr = readLikesReceived(socialProfiles, uid);
  const pc = readPlayCompletion(tasteProfiles, uid);
  const consistency = vibeConsistencyScore(taste, session);
  const raw = Math.log1p(lr) * 1.15 + Math.log1p(pc) * 0.95 + consistency * 2.15;
  return Math.min(12, Math.max(0, raw));
}

/** Extra queue sort weight beyond the +1 like (weight - 1). */
function likeInfluenceBonus(influenceScore) {
  const w = 1 + influenceScore * 0.1;
  return Math.max(0, w - 1);
}

/**
 * @returns {{ bonus: number, influenceScore: number, label: string }}
 */
function applyLikeSoftWeight(track, likerUserId, session, tasteProfiles, socialProfiles) {
  const score = computeInfluenceScore(likerUserId, session, tasteProfiles, socialProfiles);
  const bonus = likeInfluenceBonus(score);
  if (!Number.isFinite(track.softInfluenceBonus)) track.softInfluenceBonus = 0;
  track.softInfluenceBonus += bonus;
  return { bonus, influenceScore: score, label: pickSoftLikeLabel(score) };
}

function pickSoftLikeLabel(influenceScore) {
  if (influenceScore >= 4.2) return "Apporte de l'énergie";
  return 'Bon choix';
}

module.exports = {
  computeInfluenceScore,
  likeInfluenceBonus,
  applyLikeSoftWeight,
  pickSoftLikeLabel,
  vibeConsistencyScore
};
