// Round 6 smoke test: 27 scenarios driving DM + user-ban endpoints and socket events end-to-end.
// Mirrors the round-5 harness shape; captures actual HTTP bodies + socket payloads.

const { io } = require('socket.io-client');
const fetch = require('node-fetch');

const BASE = 'http://localhost:3000';
const log = (label, val) => {
  const out = typeof val === 'string' ? val : JSON.stringify(val);
  console.log(`[${label}] ${out}`);
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

function collect(s, ev) {
  const events = [];
  s.on(ev, (p) => events.push(p));
  return events;
}

function sendMessage(s, roomId, body) {
  return new Promise((resolve) => {
    s.emit('message:send', { roomId, body }, (ack) => resolve(ack));
  });
}

async function register(username) {
  const { status, body } = await http('POST', '/api/auth/register', null, {
    email: `${username}@example.com`,
    username,
    password: 'secret123',
  });
  if (status !== 201) {
    throw new Error(`register ${username} failed: ${status} ${JSON.stringify(body)}`);
  }
  return { token: body.accessToken, user: body.user };
}

async function friend(from, to) {
  // Create + accept a friend request from `from` to `to`.
  const req = await http('POST', '/api/friend-requests', from.token, {
    toUsername: to.user.username,
  });
  if (req.status !== 201) {
    throw new Error(`friend-request ${from.user.username} -> ${to.user.username}: ${req.status} ${JSON.stringify(req.body)}`);
  }
  const accepted = await http('POST', `/api/friend-requests/${req.body.id}/accept`, to.token);
  if (accepted.status !== 200) {
    throw new Error(`accept ${req.body.id}: ${accepted.status} ${JSON.stringify(accepted.body)}`);
  }
}

// Tiny delay helper for letting socket events land before inspecting collectors.
function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const stamp = Date.now();
  const aName = `alice_r6_${stamp}`;
  const bName = `bob_r6_${stamp}`;
  const cName = `carol_r6_${stamp}`;
  const dName = `dave_r6_${stamp}`;

  // Step 1 — register + sockets + friendships (A-B, A-C, B-C; D is an island).
  const a = await register(aName);
  const b = await register(bName);
  const c = await register(cName);
  const d = await register(dName);
  await friend(a, b);
  await friend(a, c);
  await friend(b, c);

  const aSock = await socket(a.token);
  const bSock = await socket(b.token);
  const cSock = await socket(c.token);
  const dSock = await socket(d.token);

  const aDmCreated = collect(aSock, 'dm:created');
  const bDmCreated = collect(bSock, 'dm:created');
  const cDmCreated = collect(cSock, 'dm:created');
  const aBanApplied = collect(aSock, 'user:ban:applied');
  const aBanRemoved = collect(aSock, 'user:ban:removed');
  const aFriendRemoved = collect(aSock, 'friend:removed');
  const aMessageNew = collect(aSock, 'message:new');
  const bMessageNew = collect(bSock, 'message:new');

  log('1', {
    setup: { aId: a.user.id, bId: b.user.id, cId: c.user.id, dId: d.user.id, stamp },
    sockets: 'A, B, C, D connected; listeners attached',
    friendships: 'A-B, A-C, B-C (D has none)',
  });

  // Step 2 — A opens DM with B: 201 RoomDetail, both sockets receive dm:created.
  const step2 = await http('POST', '/api/dm', a.token, { toUserId: b.user.id });
  await wait(200);
  const dmRoomId = step2.body?.id;
  log('2', {
    status: step2.status,
    room: step2.body,
    aDmCreatedCount: aDmCreated.length,
    aDmCreatedFirst: aDmCreated[0],
    bDmCreatedCount: bDmCreated.length,
    bDmCreatedFirst: bDmCreated[0],
  });

  // Step 3 — A re-opens: idempotent 200, no extra dm:created.
  const aDmBefore = aDmCreated.length;
  const bDmBefore = bDmCreated.length;
  const step3 = await http('POST', '/api/dm', a.token, { toUserId: b.user.id });
  await wait(200);
  log('3', {
    status: step3.status,
    roomIdMatches: step3.body?.id === dmRoomId,
    aDmCreatedDelta: aDmCreated.length - aDmBefore,
    bDmCreatedDelta: bDmCreated.length - bDmBefore,
  });

  // Step 4 — self-DM rejected with 400 verbatim.
  const step4 = await http('POST', '/api/dm', a.token, { toUserId: a.user.id });
  log('4', step4);

  // Step 5 — target UUID not in users table → 404.
  const step5 = await http('POST', '/api/dm', a.token, {
    toUserId: '00000000-0000-4000-8000-000000000000',
  });
  log('5', step5);

  // Step 6 — A tries to DM D (no friendship) → 403.
  const step6 = await http('POST', '/api/dm', a.token, { toUserId: d.user.id });
  log('6', step6);

  // Step 7 — A sends a DM message via message:send; ack ok:true; B receives message:new.
  const bMsgBefore = bMessageNew.length;
  const step7Ack = await sendMessage(aSock, dmRoomId, 'hi bob');
  await wait(200);
  log('7', {
    ack: step7Ack,
    bMessageNewDelta: bMessageNew.length - bMsgBefore,
    bMessageNewLast: bMessageNew[bMessageNew.length - 1],
  });

  // Step 8 — B fetches DM messages and sees "hi bob".
  const step8 = await http('GET', `/api/rooms/${dmRoomId}/messages`, b.token);
  log('8', { status: step8.status, count: step8.body?.length, last: step8.body?.[step8.body.length - 1] });

  // Step 9 — PATCH DM room blocked.
  const step9 = await http('PATCH', `/api/rooms/${dmRoomId}`, a.token, { name: 'foo' });
  log('9', step9);

  // Step 10 — non-member C tries to join → 403 "Direct messages are only reachable via /api/dm".
  const step10 = await http('POST', `/api/rooms/${dmRoomId}/join`, c.token);
  log('10', step10);

  // Step 11 — A leaves the DM → 403 "DM rooms cannot be left".
  const step11 = await http('POST', `/api/rooms/${dmRoomId}/leave`, a.token);
  log('11', step11);

  // Step 12 — B creates an invitation for C against the DM → 400 "DMs cannot have invitations".
  const step12 = await http('POST', `/api/rooms/${dmRoomId}/invitations`, b.token, {
    username: cName,
  });
  log('12', step12);

  // Step 13 — A creates a channel X; GET /api/rooms shows both channel + DM.
  const createChannel = await http('POST', '/api/rooms', a.token, {
    name: `channel_r6_${stamp}`,
    description: 'round-6 channel',
    visibility: 'public',
  });
  const channelId = createChannel.body?.id;
  const step13 = await http('GET', '/api/rooms', a.token);
  const channelInList = step13.body?.find?.((r) => r.id === channelId);
  const dmInList = step13.body?.find?.((r) => r.id === dmRoomId);
  log('13', {
    status: step13.status,
    total: step13.body?.length,
    channel: channelInList,
    dm: dmInList,
  });

  // Step 14 — B bans A. Expect 204, A sees user:ban:applied AND friend:removed.
  const aBanAppliedBefore = aBanApplied.length;
  const aFriendRemovedBefore = aFriendRemoved.length;
  const step14 = await http('POST', '/api/user-bans', b.token, { userId: a.user.id });
  await wait(250);
  log('14', {
    status: step14.status,
    aBanAppliedDelta: aBanApplied.length - aBanAppliedBefore,
    aBanAppliedLast: aBanApplied[aBanApplied.length - 1],
    aFriendRemovedDelta: aFriendRemoved.length - aFriendRemovedBefore,
    aFriendRemovedLast: aFriendRemoved[aFriendRemoved.length - 1],
  });

  // Step 15 — friendship severed on both sides.
  const step15B = await http('GET', '/api/friends', b.token);
  const step15A = await http('GET', '/api/friends', a.token);
  const bHasA = step15B.body?.some?.((f) => f.userId === a.user.id);
  const aHasB = step15A.body?.some?.((f) => f.userId === b.user.id);
  log('15', {
    B_friends: step15B.body,
    A_friends_has_B: aHasB,
    B_friends_has_A: bHasA,
  });

  // Step 16 — B's ban list contains A.
  const step16 = await http('GET', '/api/user-bans', b.token);
  log('16', step16);

  // Step 17 — A tries to DM-send in the banned DM: blocked ack; B doesn't receive message:new.
  const bMsgBefore17 = bMessageNew.length;
  const step17Ack = await sendMessage(aSock, dmRoomId, 'still there?');
  await wait(200);
  log('17', {
    ack: step17Ack,
    bMessageNewDelta: bMessageNew.length - bMsgBefore17,
  });

  // Step 18 — B sends the other direction: same blocked ack; A doesn't receive.
  const aMsgBefore18 = aMessageNew.length;
  const step18Ack = await sendMessage(bSock, dmRoomId, "you're blocked");
  await wait(200);
  log('18', {
    ack: step18Ack,
    aMessageNewDelta: aMessageNew.length - aMsgBefore18,
  });

  // Step 19 — A attempts to re-open a DM with B while banned → 403 "Personal messaging is blocked".
  const step19 = await http('POST', '/api/dm', a.token, { toUserId: b.user.id });
  log('19', step19);

  // Step 20 — self-ban rejected with 400.
  const step20 = await http('POST', '/api/user-bans', b.token, { userId: b.user.id });
  log('20', step20);

  // Step 21 — duplicate ban → 409 "User is already banned".
  const step21 = await http('POST', '/api/user-bans', b.token, { userId: a.user.id });
  log('21', step21);

  // Step 22 — ban non-existent user → 404 "User not found".
  const step22 = await http('POST', '/api/user-bans', b.token, {
    userId: '00000000-0000-4000-8000-000000000000',
  });
  log('22', step22);

  // Step 23 — B unbans A. A sees user:ban:removed.
  const aBanRemovedBefore = aBanRemoved.length;
  const step23 = await http('DELETE', `/api/user-bans/${a.user.id}`, b.token);
  await wait(250);
  log('23', {
    status: step23.status,
    aBanRemovedDelta: aBanRemoved.length - aBanRemovedBefore,
    aBanRemovedLast: aBanRemoved[aBanRemoved.length - 1],
  });

  // Step 24 — A DM-sends again; ack ok:true; B receives message:new.
  const bMsgBefore24 = bMessageNew.length;
  const step24Ack = await sendMessage(aSock, dmRoomId, 'ok we good?');
  await wait(200);
  log('24', {
    ack: step24Ack,
    bMessageNewDelta: bMessageNew.length - bMsgBefore24,
    bMessageNewLast: bMessageNew[bMessageNew.length - 1],
  });

  // Step 25 — second unban → 404 "Not banned".
  const step25 = await http('DELETE', `/api/user-bans/${a.user.id}`, b.token);
  log('25', step25);

  // Step 26 — friendship is NOT restored by unban.
  const step26 = await http('GET', '/api/friends', a.token);
  log('26', { status: step26.status, A_has_B: step26.body?.some?.((f) => f.userId === b.user.id), friends: step26.body });

  // Step 27 — pending friend-request cleanup on ban. A sends request to B, B bans A, A's outgoing list should NOT include the A→B row.
  // A re-sends friend-request to B; B is no longer friends with A (step 15), so this is a clean re-request.
  const step27Create = await http('POST', '/api/friend-requests', a.token, { toUsername: bName });
  log('27-create', step27Create);
  const step27Ban = await http('POST', '/api/user-bans', b.token, { userId: a.user.id });
  log('27-ban', step27Ban);
  const step27Out = await http('GET', '/api/friend-requests/outgoing', a.token);
  const step27HasAB = step27Out.body?.some?.((r) => r.fromUserId === a.user.id && r.toUserId === b.user.id);
  log('27', {
    outgoing: step27Out.body,
    A_has_pending_to_B: step27HasAB,
  });

  // Cleanup.
  aSock.disconnect();
  bSock.disconnect();
  cSock.disconnect();
  dSock.disconnect();
  log('done', 'all 27 scenarios executed');
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
