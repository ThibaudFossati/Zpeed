function initPresence(session) {
  if (!session._presence) {
    session._presence = { hostSockets: new Set(), guestSockets: new Map() };
  }
}

/** Host + guests with at least one active socket after join_room */
function totalPresenceUsers(session) {
  initPresence(session);
  const p = session._presence;
  const hostOn = p.hostSockets.size > 0;
  let guests = 0;
  for (const set of p.guestSockets.values()) {
    if (set && set.size > 0) guests++;
  }
  return (hostOn ? 1 : 0) + guests;
}

function addHostSocket(session, socketId) {
  initPresence(session);
  session._presence.hostSockets.add(socketId);
}

function removeHostSocket(session, socketId) {
  if (!session._presence) return;
  session._presence.hostSockets.delete(socketId);
}

function addGuestSocket(session, guestId, socketId) {
  initPresence(session);
  if (!session._presence.guestSockets.has(guestId)) {
    session._presence.guestSockets.set(guestId, new Set());
  }
  session._presence.guestSockets.get(guestId).add(socketId);
}

function removeGuestSocket(session, guestId, socketId) {
  if (!session._presence || !guestId) return;
  const set = session._presence.guestSockets.get(guestId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) session._presence.guestSockets.delete(guestId);
}

module.exports = {
  initPresence,
  totalPresenceUsers,
  addHostSocket,
  removeHostSocket,
  addGuestSocket,
  removeGuestSocket
};
