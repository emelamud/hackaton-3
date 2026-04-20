// Round 4 smoke test: 16 scenarios exercising invitations + PATCH /api/rooms/:id
// Drives HTTP via fetch, sockets via socket.io-client.

const { io } = require('socket.io-client');
const fetch = require('node-fetch');

const BASE = 'http://localhost:3000';
const log = (label, val) => {
  console.log(`[${label}]`, typeof val === 'string' ? val : JSON.stringify(val));
};

async function http(method, path, token, body) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, body: data };
}

function socket(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token }, transports: ['websocket'] });
    s.once('connect', () => resolve(s));
    s.once('connect_error', (e) => reject(e));
  });
}

function waitEvent(s, ev, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting ${ev}`)), timeoutMs);
    s.once(ev, (payload) => {
      clearTimeout(t);
      resolve(payload);
    });
  });
}

function collect(s, ev) {
  const events = [];
  s.on(ev, (p) => events.push(p));
  return events;
}

async function register(username) {
  const { status, body } = await http('POST', '/api/auth/register', null, {
    email: `${username}@example.com`,
    username,
    password: 'secret123',
  });
  if (status !== 201) throw new Error(`register ${username} failed: ${status} ${JSON.stringify(body)}`);
  return { token: body.accessToken, user: body.user };
}

async function main() {
  const stamp = Date.now();
  const aName = `alice_r4_${stamp}`;
  const bName = `bob_r4_${stamp}`;
  const a = await register(aName);
  const b = await register(bName);
  log('setup', { aId: a.user.id, bId: b.user.id, aName, bName });

  // A creates a private + public room.
  const privR = await http('POST', '/api/rooms', a.token, {
    name: `priv_${stamp}`,
    visibility: 'private',
  });
  const pubR = await http('POST', '/api/rooms', a.token, {
    name: `pub_${stamp}`,
    visibility: 'public',
  });
  if (privR.status !== 201 || pubR.status !== 201)
    throw new Error(`room create failed: ${JSON.stringify({ privR, pubR })}`);
  const privateId = privR.body.id;
  const publicId = pubR.body.id;
  log('rooms', { privateId, publicId });

  // Step 1: B socket listens for invitation:new and invitation:revoked.
  const bSock = await socket(b.token);
  const bInvNewEvents = collect(bSock, 'invitation:new');
  const bInvRevEvents = collect(bSock, 'invitation:revoked');
  log('1', 'B socket connected');

  // Step 2: A invites B to private room.
  const step2 = await http('POST', `/api/rooms/${privateId}/invitations`, a.token, {
    username: bName,
  });
  log('2.http', { status: step2.status, body: step2.body });
  // give socket a moment; event may arrive before or after HTTP resolution
  await new Promise((r) => setTimeout(r, 200));
  log('2.socket.count', bInvNewEvents.length);
  log('2.socket.payload', bInvNewEvents[0] || null);
  const invId = step2.body.id;

  // Step 3: duplicate invite
  const step3 = await http('POST', `/api/rooms/${privateId}/invitations`, a.token, {
    username: bName,
  });
  log('3', { status: step3.status, body: step3.body });

  // Step 4: non-existent user
  const step4 = await http('POST', `/api/rooms/${privateId}/invitations`, a.token, {
    username: 'ghost_nonexistent_user_9999',
  });
  log('4', { status: step4.status, body: step4.body });

  // Step 5: invite to public room
  const step5 = await http('POST', `/api/rooms/${publicId}/invitations`, a.token, {
    username: bName,
  });
  log('5', { status: step5.status, body: step5.body });

  // Step 6: B GET /api/invitations
  const step6 = await http('GET', '/api/invitations', b.token);
  log('6', { status: step6.status, count: Array.isArray(step6.body) ? step6.body.length : null, body: step6.body });

  // Step 7: B second socket listens for room:updated
  const bSock2 = await socket(b.token);
  const bRoomUpdatedEvents = collect(bSock2, 'room:updated');
  // Also collect on bSock.
  const bRoomUpdatedEvents1 = collect(bSock, 'room:updated');
  // A socket too
  const aSock = await socket(a.token);
  const aRoomUpdatedEvents = collect(aSock, 'room:updated');
  log('7', 'sockets set up for room:updated listening');

  // Step 8: B accepts invitation
  await new Promise((r) => setTimeout(r, 100)); // give sockets time to settle
  const step8 = await http('POST', `/api/invitations/${invId}/accept`, b.token);
  log('8.http', { status: step8.status, memberCount: step8.body?.memberCount, memberUsernames: step8.body?.members?.map((m) => m.username) });
  // wait a bit for socket events
  await new Promise((r) => setTimeout(r, 300));
  log('8.socket.bSock1', bRoomUpdatedEvents1.length ? { received: bRoomUpdatedEvents1.length, members: bRoomUpdatedEvents1[0]?.members?.map((m) => m.username) } : 'no events');
  log('8.socket.bSock2', bRoomUpdatedEvents.length ? { received: bRoomUpdatedEvents.length, members: bRoomUpdatedEvents[0]?.members?.map((m) => m.username) } : 'no events');
  log('8.socket.aSock', aRoomUpdatedEvents.length ? { received: aRoomUpdatedEvents.length, members: aRoomUpdatedEvents[0]?.members?.map((m) => m.username) } : 'no events');

  // Reset counters
  const step9RoomUpdates = [];
  aSock.off('room:updated');
  bSock.off('room:updated');
  bSock2.off('room:updated');
  aSock.on('room:updated', (p) => step9RoomUpdates.push({ who: 'a', payload: p }));
  bSock.on('room:updated', (p) => step9RoomUpdates.push({ who: 'b1', payload: p }));
  bSock2.on('room:updated', (p) => step9RoomUpdates.push({ who: 'b2', payload: p }));

  // Step 9: A PATCH name
  const step9 = await http('PATCH', `/api/rooms/${privateId}`, a.token, {
    name: `renamed_${stamp}`,
  });
  log('9.http', { status: step9.status, name: step9.body?.name });
  await new Promise((r) => setTimeout(r, 300));
  log('9.socket.count', step9RoomUpdates.length);
  log('9.socket.who', step9RoomUpdates.map((e) => e.who).sort());

  // Step 10: PATCH same name again (no-op)
  const step10 = await http('PATCH', `/api/rooms/${privateId}`, a.token, {
    name: `renamed_${stamp}`,
  });
  log('10', { status: step10.status, name: step10.body?.name });

  // Step 11: rename public room to the now-taken name
  const step11 = await http('PATCH', `/api/rooms/${publicId}`, a.token, {
    name: `renamed_${stamp}`,
  });
  log('11', { status: step11.status, body: step11.body });

  // Step 12: B patches private room (member, not owner/admin)
  const step12 = await http('PATCH', `/api/rooms/${privateId}`, b.token, {
    name: `b_rename_${stamp}`,
  });
  log('12', { status: step12.status, body: step12.body });

  // Step 13: empty body
  const step13 = await http('PATCH', `/api/rooms/${privateId}`, a.token, {});
  log('13', { status: step13.status, body: step13.body });

  // Step 14: create room C, invite B, revoke
  const cR = await http('POST', '/api/rooms', a.token, {
    name: `priv_c_${stamp}`,
    visibility: 'private',
  });
  if (cR.status !== 201) throw new Error('C room failed');
  const cId = cR.body.id;

  // Reset B's invitation listeners
  bSock.off('invitation:new');
  bSock.off('invitation:revoked');
  const cInvNew = [];
  const cInvRev = [];
  bSock.on('invitation:new', (p) => cInvNew.push(p));
  bSock.on('invitation:revoked', (p) => cInvRev.push(p));

  const inv14 = await http('POST', `/api/rooms/${cId}/invitations`, a.token, {
    username: bName,
  });
  if (inv14.status !== 201) throw new Error(`invite 14 failed: ${JSON.stringify(inv14)}`);
  await new Promise((r) => setTimeout(r, 200));
  log('14.inv.new', cInvNew.length ? { id: cInvNew[0].id, roomName: cInvNew[0].roomName } : 'none');

  const step14 = await http('DELETE', `/api/invitations/${inv14.body.id}`, a.token);
  log('14.revoke.http', { status: step14.status });
  await new Promise((r) => setTimeout(r, 200));
  log('14.revoke.socket', cInvRev.length ? cInvRev[0] : 'none');

  // Step 15: re-invite B to C, B rejects
  cInvNew.length = 0;
  cInvRev.length = 0;
  // A's socket collector for any inviter-side event (to confirm reject is silent)
  aSock.off('invitation:revoked');
  aSock.off('invitation:new');
  const aInvEvents = [];
  aSock.onAny((ev, payload) => {
    if (ev.startsWith('invitation:')) aInvEvents.push({ ev, payload });
  });

  const inv15 = await http('POST', `/api/rooms/${cId}/invitations`, a.token, {
    username: bName,
  });
  if (inv15.status !== 201) throw new Error(`invite 15 failed: ${JSON.stringify(inv15)}`);
  const step15 = await http('POST', `/api/invitations/${inv15.body.id}/reject`, b.token);
  log('15.reject.http', { status: step15.status });
  await new Promise((r) => setTimeout(r, 300));
  log('15.a.events', aInvEvents);

  // Step 16: replay — create another invite to another new room, accept twice
  const dR = await http('POST', '/api/rooms', a.token, {
    name: `priv_d_${stamp}`,
    visibility: 'private',
  });
  const dId = dR.body.id;
  const inv16 = await http('POST', `/api/rooms/${dId}/invitations`, a.token, {
    username: bName,
  });
  const invId16 = inv16.body.id;
  const accept16a = await http('POST', `/api/invitations/${invId16}/accept`, b.token);
  log('16.first', { status: accept16a.status, memberCount: accept16a.body?.memberCount });
  const accept16b = await http('POST', `/api/invitations/${invId16}/accept`, b.token);
  log('16.replay', { status: accept16b.status, body: accept16b.body });

  aSock.close();
  bSock.close();
  bSock2.close();
  console.log('\n=== SMOKE DONE ===');
  process.exit(0);
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
