/**
 * Durable-ish social stats per zpeed_user_id (localStorage), separate from taste profiles.
 * Persisted to sonder-social-profiles.json — not the final identity layer (see docs/product-architecture.md).
 */

const fs = require('fs');
const path = require('path');
const social = require('./socialMusic');

const SOCIAL_FILE = path.join(__dirname, '..', 'sonder-social-profiles.json');

function emptyStats() {
  return {
    tracksAdded: 0,
    likesReceived: 0,
    tracksPlayed: 0,
    sessionsJoined: 0,
    sessionsHosted: 0
  };
}

function migrateRow(row) {
  const base = emptyStats();
  if (!row || typeof row !== 'object') {
    return { ...base, displayName: '', updatedAt: new Date().toISOString() };
  }
  for (const k of Object.keys(base)) {
    base[k] = Math.max(0, Number(row[k]) || 0);
  }
  return {
    ...base,
    displayName: String(row.displayName || '').slice(0, 48),
    updatedAt: row.updatedAt || new Date().toISOString()
  };
}

function loadSocialProfiles(map) {
  try {
    if (!fs.existsSync(SOCIAL_FILE)) return;
    const raw = fs.readFileSync(SOCIAL_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return;
    for (const [uid, row] of Object.entries(data)) {
      if (!uid || typeof uid !== 'string') continue;
      map[uid] = migrateRow(row);
    }
  } catch (e) {
    console.warn('Could not load sonder-social-profiles.json:', e.message);
  }
}

function saveSocialProfiles(map) {
  try {
    fs.writeFileSync(SOCIAL_FILE, JSON.stringify(map, null, 2));
  } catch (e) {
    console.warn('Could not save sonder-social-profiles.json:', e.message);
  }
}

function getRow(map, userId) {
  const uid = String(userId || '').trim();
  if (!uid) return null;
  if (!map[uid]) map[uid] = migrateRow(null);
  return map[uid];
}

function touchDisplayName(map, userId, displayName) {
  const row = getRow(map, userId);
  if (!row) return;
  const n = String(displayName || '').trim();
  if (n) row.displayName = n.slice(0, 48);
  row.updatedAt = new Date().toISOString();
}

/**
 * @param {'tracksAdded'|'likesReceived'|'tracksPlayed'|'sessionsJoined'|'sessionsHosted'} field
 */
function bump(map, userId, field, displayName) {
  const row = getRow(map, userId);
  if (!row || !Object.prototype.hasOwnProperty.call(row, field)) return;
  touchDisplayName(map, userId, displayName);
  row[field] = (Number(row[field]) || 0) + 1;
  row.updatedAt = new Date().toISOString();
}

function pickRoleLabel(stats) {
  const sh = Number(stats.sessionsHosted) || 0;
  const lj = Number(stats.likesReceived) || 0;
  const ta = Number(stats.tracksAdded) || 0;
  const tp = Number(stats.tracksPlayed) || 0;
  const sj = Number(stats.sessionsJoined) || 0;
  if (sh >= 5) return 'Architecte des nuits';
  if (sh >= 1) return 'Hôte SONDER';
  if (lj >= 12) return 'Boosteur de dancefloor';
  if (ta >= 6) return 'Curateur infatigable';
  if (lj + tp >= 8) return 'Party Booster';
  if (ta >= 2) return 'Découvreur de pépites';
  if (sj >= 4) return 'Invité·e assidu·e';
  return 'Passionné·e de musique';
}

function topGenreLabelsFromTaste(tasteProfile, max = 3) {
  if (!tasteProfile || !tasteProfile.genreCounts) return [];
  const keys = social
    .deriveTopGenres(tasteProfile.genreCounts)
    .slice(0, max)
    .filter(Boolean);
  return keys.map(g => social.FRENCH_LABEL[g] || g);
}

function buildPublicProfile(userId, socialRow, tasteProfile, { preferredVibe } = {}) {
  const uid = String(userId || '').trim();
  const stats = socialRow ? migrateRow(socialRow) : migrateRow(null);
  const displayName = (stats.displayName && stats.displayName.trim()) || 'Invité·e SONDER';
  const roleLabel = pickRoleLabel(stats);
  const topGenres = topGenreLabelsFromTaste(tasteProfile, 3);
  const topGenresLine = topGenres.length ? topGenres.join(' · ') : 'Mix & découvertes';
  return {
    userId: uid,
    displayName: displayName.slice(0, 48),
    roleLabel,
    topGenres,
    topGenresLine,
    stats: {
      tracksAdded: stats.tracksAdded,
      likesReceived: stats.likesReceived,
      tracksPlayed: stats.tracksPlayed,
      sessionsJoined: stats.sessionsJoined,
      sessionsHosted: stats.sessionsHosted
    },
    preferredVibe: preferredVibe && String(preferredVibe).trim() ? String(preferredVibe).trim() : null
  };
}

module.exports = {
  SOCIAL_FILE,
  loadSocialProfiles,
  saveSocialProfiles,
  getRow,
  touchDisplayName,
  bump,
  buildPublicProfile,
  pickRoleLabel,
  topGenreLabelsFromTaste
};
