/**
 * Dynamic vote threshold from connected user count (host + guests).
 * 1–3 users → 2, 4–6 → 3, 7+ → 4
 */
function voteThreshold(totalUsers) {
  const n = Math.max(0, Number(totalUsers) || 0);
  if (n <= 3) return 2;
  if (n <= 6) return 3;
  return 4;
}

module.exports = { voteThreshold };
