// Round 12 smoke test — unread tracking + public-room catalog.
// Drives 21 scenarios against a live backend (port 3000) using node-fetch +
// socket.io-client. Captures observed HTTP bodies / socket payloads per
// scenario.

const { io } = require('socket.io-client');
const fetch = require('node-fetch');
const crypto = require('crypto');

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

function openSocket(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
    s.__roomReads = [];
    s.__msgs = [];
    s.on('room:read', (p) => s.__roomReads.push(p));
    s.on('message:new', (p) => s.__msgs.push(p));
    s.once('connect', () => resolve(s));
    s.once('connect_error', (e) => reject(e));
  });
}

function sendMessage(sock, payload) {
  return new Promise((resolve) => {
    sock.emit('message:send', payload, (ack) => resolve(ack));
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

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomUuid() {
  return crypto.randomUUID();
}

// ----------------------------------------------------------------------------

async function main() {
  const stamp = Date.now();
  const aName = `alice_r12_${stamp}`;
  const bName = `bob_r12_${stamp}`;
  const cName = `carol_r12_${stamp}`;

  const alice = await register(aName);
  const bob = await register(bName);
  const carol = await register(cName);

  // Create rooms in DESCENDING chronological order so catalog newest-first
  // ordering is easy to assert: general → eng → random → ops. Order of
  // creation = ASC; newest-first = ops (private) > random > eng > general.
  const genRes = await http('POST', '/api/rooms', alice.token, {
    name: `general-${stamp}`,
    visibility: 'public',
  });
  if (genRes.status !== 201) {
    throw new Error(`create general failed: ${genRes.status} ${JSON.stringify(genRes.body)}`);
  }
  const general = genRes.body;
  await wait(5); // ensure a distinct createdAt for stable ordering

  const engRes = await http('POST', '/api/rooms', alice.token, {
    name: `eng-${stamp}`,
    description: 'Backend and frontend discussions',
    visibility: 'public',
  });
  const eng = engRes.body;
  await wait(5);

  const randRes = await http('POST', '/api/rooms', alice.token, {
    name: `random-${stamp}`,
    description: 'Off-topic chatter',
    visibility: 'public',
  });
  const random = randRes.body;
  await wait(5);

  const opsRes = await http('POST', '/api/rooms', alice.token, {
    name: `ops-${stamp}`,
    description: 'Private ops',
    visibility: 'private',
  });
  const ops = opsRes.body;

  // bob + carol join #general and #eng; only bob joins #random.
  await http('POST', `/api/rooms/${general.id}/join`, bob.token);
  await http('POST', `/api/rooms/${general.id}/join`, carol.token);
  await http('POST', `/api/rooms/${eng.id}/join`, bob.token);
  await http('POST', `/api/rooms/${eng.id}/join`, carol.token);
  await http('POST', `/api/rooms/${random.id}/join`, bob.token);

  log('setup', {
    aliceId: alice.user.id,
    bobId: bob.user.id,
    carolId: carol.user.id,
    generalId: general.id,
    engId: eng.id,
    randomId: random.id,
    opsId: ops.id,
  });

  // Open alice's socket for seeding. Pace at 210ms per send (Round 9 pattern).
  const sAlice = await openSocket(alice.token);
  await wait(200);

  // Seed #eng with 30 messages.
  for (let i = 0; i < 30; i++) {
    const ack = await sendMessage(sAlice, {
      roomId: eng.id,
      body: `eng-seed-${i}`,
      attachmentIds: [],
    });
    if (!ack.ok) throw new Error(`seed eng ${i} failed: ${JSON.stringify(ack)}`);
    await wait(210);
  }
  log('seed_eng', { count: 30 });

  // Seed #general with 10 messages.
  for (let i = 0; i < 10; i++) {
    const ack = await sendMessage(sAlice, {
      roomId: general.id,
      body: `general-seed-${i}`,
      attachmentIds: [],
    });
    if (!ack.ok) throw new Error(`seed general ${i} failed: ${JSON.stringify(ack)}`);
    await wait(210);
  }
  log('seed_general', { count: 10 });

  // #random seeded with 0 messages.

  // Open bob's socket BEFORE scenario 3 so the `room:read` event is observed.
  const sBob = await openSocket(bob.token);
  await wait(200);

  // --------------------------------------------------------------------------
  // Scenario 1 — Initial unread snapshot for bob.
  const s1 = await http('GET', '/api/unread', bob.token);
  log('1.raw', s1);
  const s1eng = s1.body.find((r) => r.roomId === eng.id);
  const s1gen = s1.body.find((r) => r.roomId === general.id);
  const s1rand = s1.body.find((r) => r.roomId === random.id);
  log('1', {
    status: s1.status,
    engUnread: s1eng ? s1eng.unreadCount : null,
    engLastReadAt: s1eng ? s1eng.lastReadAt : null,
    generalUnread: s1gen ? s1gen.unreadCount : null,
    generalLastReadAt: s1gen ? s1gen.lastReadAt : null,
    randomAbsent: s1rand === undefined,
    totalRows: s1.body.length,
  });

  // Scenario 2 — alice sees everything as zero (her own messages don't count).
  const s2 = await http('GET', '/api/unread', alice.token);
  log('2', {
    status: s2.status,
    body: s2.body,
    length: s2.body.length,
  });

  // Scenario 3 — Mark #eng read as bob.
  const t3start = Date.now();
  const s3 = await http('POST', `/api/rooms/${eng.id}/read`, bob.token);
  const t3elapsed = Date.now() - t3start;
  log('3', {
    status: s3.status,
    body: s3.body,
    elapsedMs: t3elapsed,
    lastReadAtWithin2s: Math.abs(Date.now() - new Date(s3.body.lastReadAt).getTime()) < 2000,
  });
  const bobEngLastReadAt1 = s3.body.lastReadAt;

  // Scenario 5 — `room:read` socket event fires for bob (scenario 3 just fired).
  await wait(250); // allow the socket event to land.
  const s5events = sBob.__roomReads.slice();
  log('5', {
    eventCount: s5events.length,
    latest: s5events[s5events.length - 1] || null,
    matchesHttp:
      s5events.length >= 1 &&
      s5events[s5events.length - 1].roomId === eng.id &&
      s5events[s5events.length - 1].lastReadAt === bobEngLastReadAt1,
  });

  // Scenario 4 — Subsequent unread snapshot for bob.
  const s4 = await http('GET', '/api/unread', bob.token);
  log('4.raw', s4);
  const s4eng = s4.body.find((r) => r.roomId === eng.id);
  const s4gen = s4.body.find((r) => r.roomId === general.id);
  log('4', {
    status: s4.status,
    engUnread: s4eng ? s4eng.unreadCount : 0,
    engAbsent: s4eng === undefined,
    engLastReadAt: s4eng ? s4eng.lastReadAt : null,
    generalUnread: s4gen ? s4gen.unreadCount : null,
  });

  // Scenario 6 — New messages bump unread for bob.
  for (let i = 0; i < 5; i++) {
    const ack = await sendMessage(sAlice, {
      roomId: eng.id,
      body: `post-read-${i}`,
      attachmentIds: [],
    });
    if (!ack.ok) throw new Error(`post-read send ${i} failed: ${JSON.stringify(ack)}`);
    await wait(210);
  }
  await wait(200);
  const s6 = await http('GET', '/api/unread', bob.token);
  log('6.raw', s6);
  const s6eng = s6.body.find((r) => r.roomId === eng.id);
  log('6', {
    status: s6.status,
    engUnread: s6eng ? s6eng.unreadCount : null,
    engLastReadAt: s6eng ? s6eng.lastReadAt : null,
  });

  // Scenario 7 — Mark-read is monotonic.
  const s7a = await http('POST', `/api/rooms/${eng.id}/read`, bob.token);
  const lastReadAt_1 = s7a.body.lastReadAt;
  await wait(50);
  const s7b = await http('POST', `/api/rooms/${eng.id}/read`, bob.token);
  const lastReadAt_2 = s7b.body.lastReadAt;
  const monotonic = new Date(lastReadAt_2).getTime() >= new Date(lastReadAt_1).getTime();
  log('7', {
    call1: s7a.body,
    call2: s7b.body,
    monotonic,
  });

  // Scenario 8 — Mark-read on non-member (carol POSTs to #random).
  const s8 = await http('POST', `/api/rooms/${random.id}/read`, carol.token);
  log('8', { status: s8.status, body: s8.body });

  // Scenario 9 — Mark-read on unknown room.
  const unknownRoomId = randomUuid();
  const s9 = await http('POST', `/api/rooms/${unknownRoomId}/read`, bob.token);
  log('9', { status: s9.status, body: s9.body });

  // Scenario 10 — Catalog: no query, no cursor (as carol).
  const s10 = await http('GET', '/api/rooms/catalog', carol.token);
  log('10.raw', s10);
  const s10ids = s10.body.rooms.map((r) => r.id);
  const s10byId = Object.fromEntries(s10.body.rooms.map((r) => [r.id, r]));
  log('10', {
    status: s10.status,
    roomsCount: s10.body.rooms.length,
    hasMore: s10.body.hasMore,
    nextCursor: s10.body.nextCursor,
    generalPresent: s10ids.includes(general.id),
    engPresent: s10ids.includes(eng.id),
    randomPresent: s10ids.includes(random.id),
    opsAbsent: !s10ids.includes(ops.id),
    generalIsMember: s10byId[general.id]?.isMember,
    engIsMember: s10byId[eng.id]?.isMember,
    randomIsMember: s10byId[random.id]?.isMember,
    order: s10ids,
    newestFirst:
      s10.body.rooms.length >= 2 &&
      new Date(s10.body.rooms[0].createdAt).getTime() >=
        new Date(s10.body.rooms[s10.body.rooms.length - 1].createdAt).getTime(),
  });

  // Scenario 11 — Catalog: limit=2.
  const s11 = await http('GET', '/api/rooms/catalog?limit=2', carol.token);
  log('11.raw', s11);
  log('11', {
    status: s11.status,
    roomsLength: s11.body.rooms.length,
    hasMore: s11.body.hasMore,
    nextCursor: s11.body.nextCursor,
    nextCursorIsLastId:
      s11.body.nextCursor === s11.body.rooms[s11.body.rooms.length - 1].id,
  });

  // Scenario 12 — Catalog: cursor pagination.
  const s12 = await http(
    'GET',
    `/api/rooms/catalog?limit=2&cursor=${s11.body.nextCursor}`,
    carol.token,
  );
  log('12.raw', s12);
  const s11Ids = new Set(s11.body.rooms.map((r) => r.id));
  const s12Ids = s12.body.rooms.map((r) => r.id);
  log('12', {
    status: s12.status,
    roomsLength: s12.body.rooms.length,
    hasMore: s12.body.hasMore,
    nextCursor: s12.body.nextCursor,
    noOverlap: s12Ids.every((id) => !s11Ids.has(id)),
  });

  // Scenario 13 — Catalog: search by name.
  const s13 = await http('GET', `/api/rooms/catalog?q=eng`, carol.token);
  log('13.raw', s13);
  const s13Ids = s13.body.rooms.map((r) => r.id);
  log('13', {
    status: s13.status,
    roomsCount: s13.body.rooms.length,
    onlyEng: s13Ids.length === 1 && s13Ids[0] === eng.id,
    engIsMember: s13.body.rooms[0]?.isMember,
  });

  // Scenario 14 — Catalog: search by description.
  const s14 = await http('GET', `/api/rooms/catalog?q=frontend`, carol.token);
  log('14.raw', s14);
  const s14Ids = s14.body.rooms.map((r) => r.id);
  log('14', {
    status: s14.status,
    roomsCount: s14.body.rooms.length,
    onlyEng: s14Ids.length === 1 && s14Ids[0] === eng.id,
  });

  // Scenario 15 — Catalog: invalid cursor (non-existent UUID).
  const fakeCursor = randomUuid();
  const s15 = await http('GET', `/api/rooms/catalog?cursor=${fakeCursor}`, carol.token);
  log('15', { status: s15.status, body: s15.body });

  // Scenario 16 — Catalog: invalid cursor (private room id).
  const s16 = await http('GET', `/api/rooms/catalog?cursor=${ops.id}`, carol.token);
  log('16', { status: s16.status, body: s16.body });

  // Scenario 17 — Catalog: limit out of range.
  const s17a = await http('GET', `/api/rooms/catalog?limit=0`, carol.token);
  const s17b = await http('GET', `/api/rooms/catalog?limit=100`, carol.token);
  log('17', {
    zero: { status: s17a.status, error: s17a.body.error },
    hundred: { status: s17b.status, error: s17b.body.error },
  });

  // Scenario 18 — Catalog: q too long (65 chars).
  const longQ = 'a'.repeat(65);
  const s18 = await http('GET', `/api/rooms/catalog?q=${longQ}`, carol.token);
  log('18', { status: s18.status, error: s18.body.error });

  // Scenario 19 — Catalog: unauthenticated.
  const s19 = await http('GET', `/api/rooms/catalog`, null);
  log('19', { status: s19.status, body: s19.body });

  // Scenario 20 — Catalog: join flow.
  const s20join = await http('POST', `/api/rooms/${random.id}/join`, carol.token);
  const s20cat = await http('GET', `/api/rooms/catalog`, carol.token);
  const s20random = s20cat.body.rooms.find((r) => r.id === random.id);
  log('20', {
    joinStatus: s20join.status,
    catStatus: s20cat.status,
    randomIsMember: s20random?.isMember,
  });

  // Scenario 21 — DM unread sanity.
  // Befriend bob + carol so the DM can be opened.
  const frReq = await http('POST', '/api/friend-requests', carol.token, {
    toUsername: bName,
  });
  if (frReq.status !== 201) {
    throw new Error(`friend request carol->bob failed: ${JSON.stringify(frReq.body)}`);
  }
  const frAccept = await http(
    'POST',
    `/api/friend-requests/${frReq.body.id}/accept`,
    bob.token,
  );
  if (frAccept.status !== 200) {
    throw new Error(`friend accept failed: ${JSON.stringify(frAccept.body)}`);
  }

  const dmOpen = await http('POST', '/api/dm', carol.token, {
    toUserId: bob.user.id,
  });
  if (dmOpen.status !== 201 && dmOpen.status !== 200) {
    throw new Error(`dm open failed: ${JSON.stringify(dmOpen.body)}`);
  }
  const dmId = dmOpen.body.id;

  // bob sends 2 messages in the DM.
  for (let i = 0; i < 2; i++) {
    const ack = await sendMessage(sBob, {
      roomId: dmId,
      body: `dm-${i}`,
      attachmentIds: [],
    });
    if (!ack.ok) throw new Error(`dm send ${i} failed: ${JSON.stringify(ack)}`);
    await wait(210);
  }
  await wait(200);
  const s21a = await http('GET', '/api/unread', carol.token);
  const s21dm = s21a.body.find((r) => r.roomId === dmId);
  const s21read = await http('POST', `/api/rooms/${dmId}/read`, carol.token);
  await wait(100);
  const s21b = await http('GET', '/api/unread', carol.token);
  const s21dmAfter = s21b.body.find((r) => r.roomId === dmId);
  log('21', {
    dmId,
    beforeReadUnread: s21dm ? s21dm.unreadCount : null,
    beforeReadLastReadAt: s21dm ? s21dm.lastReadAt : null,
    markReadStatus: s21read.status,
    markReadBody: s21read.body,
    afterReadUnread: s21dmAfter ? s21dmAfter.unreadCount : 0,
    afterReadDmAbsent: s21dmAfter === undefined,
  });

  sAlice.close();
  sBob.close();
  log('done', 'smoke complete');
}

main().catch((err) => {
  console.error('smoke failed:', err);
  process.exit(1);
});
