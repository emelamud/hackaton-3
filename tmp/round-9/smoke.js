// Round 9 smoke test — cursor-paginated message history.
// Drives 15 scenarios against a live backend (port 3000) using node-fetch +
// socket.io-client + a hand-rolled multipart builder for attachment uploads.
//
// Captures observed HTTP bodies / socket payloads per scenario.

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

function buildMultipart(fields, filePart) {
  const boundary = '----smokeboundary' + crypto.randomBytes(8).toString('hex');
  const CRLF = '\r\n';
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    parts.push(Buffer.from(`--${boundary}${CRLF}`));
    parts.push(
      Buffer.from(`Content-Disposition: form-data; name="${k}"${CRLF}${CRLF}`),
    );
    parts.push(Buffer.from(String(v)));
    parts.push(Buffer.from(CRLF));
  }
  if (filePart) {
    parts.push(Buffer.from(`--${boundary}${CRLF}`));
    parts.push(
      Buffer.from(
        `Content-Disposition: form-data; name="file"; filename="${filePart.filename}"${CRLF}`,
      ),
    );
    parts.push(
      Buffer.from(
        `Content-Type: ${filePart.contentType || 'application/octet-stream'}${CRLF}${CRLF}`,
      ),
    );
    parts.push(filePart.buffer);
    parts.push(Buffer.from(CRLF));
  }
  parts.push(Buffer.from(`--${boundary}--${CRLF}`));
  return { body: Buffer.concat(parts), boundary };
}

async function uploadAttachment(token, { roomId, comment, filename, contentType, buffer }) {
  const { body, boundary } = buildMultipart(
    { roomId, comment },
    { filename, contentType, buffer },
  );
  const headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'content-length': String(body.length),
  };
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + '/api/attachments', {
    method: 'POST',
    headers,
    body,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

function openSocket(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
    s.__msgs = [];
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

// Smallest-plausible PNG signature padded with NULs to the requested size.
function smallPng(sizeBytes = 1024) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (sizeBytes <= sig.length) return sig.slice(0, sizeBytes);
  return Buffer.concat([sig, Buffer.alloc(sizeBytes - sig.length, 0x00)]);
}

// ----------------------------------------------------------------------------

async function main() {
  const stamp = Date.now();
  const aName = `alice_r9_${stamp}`;
  const bName = `bob_r9_${stamp}`;
  const cName = `carol_r9_${stamp}`;

  const alice = await register(aName);
  const bob = await register(bName);
  const carol = await register(cName);

  // Channels: #history (alice + bob), #other (alice + bob, one message),
  // #empty (alice only), #fifty (alice only, exactly 50 messages).
  const histCreate = await http('POST', '/api/rooms', alice.token, {
    name: `history-${stamp}`,
    visibility: 'public',
  });
  if (histCreate.status !== 201) {
    throw new Error(
      `create history failed: ${histCreate.status} ${JSON.stringify(histCreate.body)}`,
    );
  }
  const history = histCreate.body;
  await http('POST', `/api/rooms/${history.id}/join`, bob.token);

  const otherCreate = await http('POST', '/api/rooms', alice.token, {
    name: `other-${stamp}`,
    visibility: 'public',
  });
  const other = otherCreate.body;
  await http('POST', `/api/rooms/${other.id}/join`, bob.token);

  const emptyCreate = await http('POST', '/api/rooms', alice.token, {
    name: `empty-${stamp}`,
    visibility: 'public',
  });
  const empty = emptyCreate.body;

  const fiftyCreate = await http('POST', '/api/rooms', alice.token, {
    name: `fifty-${stamp}`,
    visibility: 'public',
  });
  const fifty = fiftyCreate.body;

  log('setup', {
    aliceId: alice.user.id,
    bobId: bob.user.id,
    carolId: carol.user.id,
    historyId: history.id,
    otherId: other.id,
    emptyId: empty.id,
    fiftyId: fifty.id,
  });

  const sAlice = await openSocket(alice.token);
  const sBob = await openSocket(bob.token);
  await wait(200);

  // --------------------------------------------------------------------------
  // Seed #history with 125 messages. Every 12th message carries an image
  // attachment — spread across the 125, so pagination pages include both
  // pure-body and body+attachment rows. ~10-11 of the 125 end up with attachments.

  const SEED_COUNT = 125;
  const ATTACH_EVERY = 12; // 125 / 12 => indices 0,12,24,36,48,60,72,84,96,108,120 → 11 attachments
  let attachedCount = 0;
  for (let i = 0; i < SEED_COUNT; i++) {
    const body = `msg-${i}`;
    let attachmentIds = [];
    if (i % ATTACH_EVERY === 0) {
      const up = await uploadAttachment(alice.token, {
        roomId: history.id,
        comment: `comment-${i}`,
        filename: `image-${i}.png`,
        contentType: 'image/png',
        buffer: smallPng(256 + i),
      });
      if (up.status !== 201) {
        throw new Error(
          `seed upload ${i} failed: ${up.status} ${JSON.stringify(up.body)}`,
        );
      }
      attachmentIds.push(up.body.attachment.id);
      attachedCount++;
    }
    const ack = await sendMessage(sAlice, {
      roomId: history.id,
      body,
      attachmentIds,
    });
    if (!ack.ok) {
      throw new Error(`seed send ${i} failed: ${JSON.stringify(ack)}`);
    }
    // Pace under the socket rate-limit (5/sec refill, burst 10).
    await wait(210);
  }
  log('seed_history', { count: SEED_COUNT, attachedCount });

  // Seed #other with a single message (alice).
  const otherAck = await sendMessage(sAlice, {
    roomId: other.id,
    body: 'only-message-in-other',
    attachmentIds: [],
  });
  const otherMessageId = otherAck.message.id;
  log('seed_other', { otherMessageId });

  // Seed #fifty with exactly 50 messages.
  for (let i = 0; i < 50; i++) {
    const ack = await sendMessage(sAlice, {
      roomId: fifty.id,
      body: `fifty-${i}`,
      attachmentIds: [],
    });
    if (!ack.ok) throw new Error(`fifty seed ${i} failed: ${JSON.stringify(ack)}`);
    await wait(210);
  }
  log('seed_fifty', { count: 50 });

  // --------------------------------------------------------------------------
  // Scenario 1 — Initial page (no cursor).
  const s1 = await http('GET', `/api/rooms/${history.id}/messages`, bob.token);
  const s1msgs = s1.body.messages;
  const s1hasMore = s1.body.hasMore;
  const s1asc =
    s1msgs.length === 50 &&
    new Date(s1msgs[0].createdAt).getTime() <
      new Date(s1msgs[49].createdAt).getTime();
  const s1newestBody = s1msgs[49].body; // should be "msg-124" (newest)
  const s1withAttach = s1msgs.filter((m) => m.attachments !== undefined);
  const s1withoutAttach = s1msgs.filter((m) => m.attachments === undefined);
  const attShape =
    s1withAttach.length > 0
      ? Object.keys(s1withAttach[0].attachments[0]).sort()
      : [];
  log('1', {
    status: s1.status,
    messagesLength: s1msgs.length,
    hasMore: s1hasMore,
    asc: s1asc,
    newestBody: s1newestBody,
    withAttachCount: s1withAttach.length,
    withoutAttachCount: s1withoutAttach.length,
    sampleAttachmentKeys: attShape,
    sampleAttachment: s1withAttach[0] ? s1withAttach[0].attachments[0] : null,
    emptyArrayOnBareMsg: s1withoutAttach[0]
      ? 'attachments' in s1withoutAttach[0]
      : 'n/a',
  });

  // Scenario 2 — Custom limit.
  const s2 = await http(
    'GET',
    `/api/rooms/${history.id}/messages?limit=25`,
    bob.token,
  );
  log('2', {
    status: s2.status,
    messagesLength: s2.body.messages.length,
    hasMore: s2.body.hasMore,
    newestBody: s2.body.messages[s2.body.messages.length - 1].body,
  });

  // Scenario 3 — Second page via `before`.
  const cursor1 = s1msgs[0].id;
  const s3 = await http(
    'GET',
    `/api/rooms/${history.id}/messages?before=${cursor1}`,
    bob.token,
  );
  const s3msgs = s3.body.messages;
  const s3strictlyOlder =
    new Date(s3msgs[s3msgs.length - 1].createdAt).getTime() <=
    new Date(s1msgs[0].createdAt).getTime();
  const overlapIds = s3msgs.filter((m) => s1msgs.some((s) => s.id === m.id));
  log('3', {
    status: s3.status,
    messagesLength: s3msgs.length,
    hasMore: s3.body.hasMore,
    strictlyOlder: s3strictlyOlder,
    overlap: overlapIds.length,
    oldestBody: s3msgs[0].body,
    newestBody: s3msgs[s3msgs.length - 1].body,
  });

  // Scenario 4 — Walk to the floor.
  let walkTotal = s1msgs.length;
  let walkCursor = s1msgs[0].id;
  let pageCount = 1;
  const seenIds = new Set(s1msgs.map((m) => m.id));
  let lastHasMore = s1hasMore;
  let lastPageLen = s1msgs.length;
  while (lastHasMore) {
    const r = await http(
      'GET',
      `/api/rooms/${history.id}/messages?before=${walkCursor}`,
      bob.token,
    );
    const pm = r.body.messages;
    for (const m of pm) {
      if (seenIds.has(m.id)) {
        throw new Error(`duplicate id during walk: ${m.id}`);
      }
      seenIds.add(m.id);
    }
    walkTotal += pm.length;
    walkCursor = pm[0] ? pm[0].id : walkCursor;
    lastHasMore = r.body.hasMore;
    lastPageLen = pm.length;
    pageCount++;
    if (pageCount > 20) throw new Error('walk runaway');
  }
  log('4', {
    pages: pageCount,
    total: walkTotal,
    lastPageLen,
    finalHasMore: lastHasMore,
    expected: SEED_COUNT,
  });

  // Scenario 5 — Attachment hydration across pages.
  // Find a page containing an attachment message. Scenario 1 page already has
  // them (msg-108, msg-120). Pick one and download via bob.
  const s5msg = s1msgs.find((m) => m.attachments && m.attachments.length > 0);
  const s5att = s5msg ? s5msg.attachments[0] : null;
  const s5keys = s5att ? Object.keys(s5att).sort() : [];
  const expectedKeys = [
    'comment',
    'createdAt',
    'filename',
    'id',
    'kind',
    'mimeType',
    'roomId',
    'sizeBytes',
    'uploaderId',
  ];
  const keysMatch =
    JSON.stringify(s5keys) === JSON.stringify(expectedKeys.sort());
  // Also check internals are omitted
  const noStatus = s5att && !('status' in s5att);
  const noMessageId = s5att && !('messageId' in s5att);
  const noStoragePath = s5att && !('storagePath' in s5att);
  // Download.
  let s5dl = null;
  if (s5att) {
    const res = await fetch(BASE + `/api/attachments/${s5att.id}`, {
      headers: { authorization: `Bearer ${bob.token}` },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    s5dl = {
      status: res.status,
      contentType: res.headers.get('content-type'),
      byteLen: buf.length,
      sizeBytes: s5att.sizeBytes,
      matches: buf.length === s5att.sizeBytes,
    };
  }
  log('5', {
    attachmentKeys: s5keys,
    keysMatchContract: keysMatch,
    noStatus,
    noMessageId,
    noStoragePath,
    download: s5dl,
    sampleAttachment: s5att,
  });

  // Scenario 6 — Invalid cursor (non-existent UUID).
  const randomUuid = crypto.randomUUID();
  const s6 = await http(
    'GET',
    `/api/rooms/${history.id}/messages?before=${randomUuid}`,
    bob.token,
  );
  log('6', { status: s6.status, body: s6.body });

  // Scenario 7 — Invalid cursor (wrong room — other's message id).
  const s7 = await http(
    'GET',
    `/api/rooms/${history.id}/messages?before=${otherMessageId}`,
    bob.token,
  );
  log('7', { status: s7.status, body: s7.body });

  // Scenario 8 — Invalid cursor (malformed UUID — zod validation layer).
  const s8 = await http(
    'GET',
    `/api/rooms/${history.id}/messages?before=not-a-uuid`,
    bob.token,
  );
  log('8', { status: s8.status, body: s8.body });

  // Scenario 9 — Limit out of range (0 and 500).
  const s9a = await http(
    'GET',
    `/api/rooms/${history.id}/messages?limit=0`,
    bob.token,
  );
  const s9b = await http(
    'GET',
    `/api/rooms/${history.id}/messages?limit=500`,
    bob.token,
  );
  log('9', {
    limit0: { status: s9a.status, body: s9a.body },
    limit500: { status: s9b.status, body: s9b.body },
  });

  // Scenario 10 — Non-member (carol not in #history).
  const s10 = await http(
    'GET',
    `/api/rooms/${history.id}/messages`,
    carol.token,
  );
  log('10', { status: s10.status, body: s10.body });

  // Scenario 11 — Room not found.
  const randomRoomId = crypto.randomUUID();
  const s11 = await http('GET', `/api/rooms/${randomRoomId}/messages`, bob.token);
  log('11', { status: s11.status, body: s11.body });

  // Scenario 12 — Unauthenticated.
  const s12 = await http('GET', `/api/rooms/${history.id}/messages`, null);
  log('12', { status: s12.status, body: s12.body });

  // Scenario 13 — Live send does not poison pagination.
  // Take a cursor pointing to scenario-1's oldest message, send a new message
  // to the room AFTER that, then fetch with the same cursor and assert the
  // new message is NOT leaked into the older page.
  const heldCursor = s1msgs[0].id; // older than everything in s1
  const liveAck = await sendMessage(sAlice, {
    roomId: history.id,
    body: 'LIVE-MESSAGE-AFTER-CURSOR',
    attachmentIds: [],
  });
  const liveId = liveAck.message.id;
  // Walk from held cursor (fetching older-than cursor), confirm liveId is
  // never in any page.
  const s13 = await http(
    'GET',
    `/api/rooms/${history.id}/messages?before=${heldCursor}`,
    bob.token,
  );
  const leaked = s13.body.messages.some((m) => m.id === liveId);
  // Fresh no-cursor fetch should include the new message as the newest.
  const s13fresh = await http(
    'GET',
    `/api/rooms/${history.id}/messages`,
    bob.token,
  );
  const freshNewest = s13fresh.body.messages[s13fresh.body.messages.length - 1];
  log('13', {
    pageStatus: s13.status,
    pageMessagesLen: s13.body.messages.length,
    liveLeakedIntoOldPage: leaked,
    freshNewestBody: freshNewest.body,
    freshNewestIsLive: freshNewest.id === liveId,
  });

  // Scenario 14 — Empty room.
  const s14 = await http(
    'GET',
    `/api/rooms/${empty.id}/messages`,
    alice.token,
  );
  log('14', { status: s14.status, body: s14.body });

  // Scenario 15 — Exactly-50 room (critical off-by-one regression trap).
  const s15 = await http(
    'GET',
    `/api/rooms/${fifty.id}/messages`,
    alice.token,
  );
  log('15', {
    status: s15.status,
    messagesLength: s15.body.messages.length,
    hasMore: s15.body.hasMore,
  });

  sAlice.disconnect();
  sBob.disconnect();
  log('done', 'all 15 scenarios executed');
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
