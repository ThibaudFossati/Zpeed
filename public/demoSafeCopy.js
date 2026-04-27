/**
 * Demo-safe copy for socket toasts — never surface raw technical strings.
 * Loaded before inline scripts in host.html / guest.html.
 */
(function (w) {
  var MSG_SPOTIFY_OPEN = 'Ouvre Spotify une fois puis reviens';
  var MSG_RATE =
    'Spotify limite les requêtes. Réessaie dans quelques minutes.';
  var MSG_RETRY = 'Réessaie dans un instant.';

  function sanitizeNotificationMessage(raw) {
    if (raw == null) return '';
    var s = String(raw).trim();
    if (!s) return '';
    if (/\n\s*at\s+/.test(s) || s.length > 360) return MSG_RETRY;
    var m = s.toLowerCase();
    if (/\b429\b/.test(s) || /\brate[\s_-]?limit\b/i.test(s) || /too many requests/i.test(s))
      return MSG_RATE;
    if (/\b(401|403)\b/.test(s)) return MSG_SPOTIFY_OPEN;
    if (
      /\b(token|oauth)\b/i.test(m) ||
      /\b(expired|unauthorized|forbidden)\b/i.test(m) ||
      /\bauth\b/.test(m)
    )
      return MSG_SPOTIFY_OPEN;
    if (
      /\b(network|fetch|failed|econn|etimed|timeout)\b/i.test(m) ||
      /connection (refused|reset)/i.test(m) ||
      /\beconn/i.test(m) ||
      /\benotfound\b/i.test(m)
    )
      return MSG_RETRY;
    return s;
  }

  w.sanitizeNotificationMessage = sanitizeNotificationMessage;
})(typeof window !== 'undefined' ? window : this);
