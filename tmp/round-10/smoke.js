// Round 10 smoke — reply / edit / delete message actions.
// Drives 24 scenarios against a live backend (port 3000) using node-fetch +
// socket.io-client + a hand-rolled multipart builder for attachment uploads.
//
// Captures observed HTTP bodies / socket payloads verbatim per scenario.
//
// Seed pacing: 210 ms per `message:send` to stay under the socket rate limit
// (5 msgs/sec refill, burst 10). Same pattern as Round 9 / Round 12 smokes.

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
    s.__new = [];
    s.__edit = [];
    s.__delete = [];
    s.on('message:new', (p) => s.__new.push(p));
    s.on('message:edit', (p) => s.__edit.push(p));
    s.on('message:delete', (p) => s.__delete.push(p));
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

function smallPng(sizeBytes = 1024) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (sizeBytes <= sig.length) return sig.slice(0, sizeBytes);
  return Buffer.concat([sig, Buffer.alloc(sizeBytes - sig.length, 0x00)]);
}

// Throttled send that also spaces out the rate limit bucket.
async function sendPaced(sock, payload) {
  const ack = await sendMessage(sock, payload);
  await wait(210);
  return ack;
}

// ----------------------------------------------------------------------------

async function main() {
  const stamp = Date.now();
  const aName = `alice_r10_${stamp}`;
  const bName = `bob_r10_${stamp}`;
  const cName = `carol_r10_${stamp}`;
  const dName = `dave_r10_${stamp}`;

  const alice = await register(aName);
  const bob = await register(bName);
  const carol = await register(cName);
  const dave = await register(dName);

  // Primary channel (alice+bob). Secondary channel (alice+bob) for cross-room
  // reply test. #solo (alice only) — used as the non-member scenario.
  const chatCreate = await http('POST', '/api/rooms', alice.token, {
    name: `chat-${stamp}`,
    visibility: 'public',
  });
  if (chatCreate.status !== 201) {
    throw new Error(`create chat failed: ${chatCreate.status} ${JSON.stringify(chatCreate.body)}`);
  }
  const chat = chatCreate.body;
  await http('POST', `/api/rooms/${chat.id}/join`, bob.token);

  const otherCreate = await http('POST', '/api/rooms', alice.token, {
    name: `other-${stamp}`,
    visibility: 'public',
  });
  const other = otherCreate.body;
  await http('POST', `/api/rooms/${other.id}/join`, bob.token);

  const soloCreate = await http('POST', '/api/rooms', alice.token, {
    name: `solo-${stamp}`,
    visibility: 'public',
  });
  const solo = soloCreate.body;

  // DM — alice <-> dave (used for DM-ban gate scenarios).
  const dmCreate = await http('POST', '/api/dm', alice.token, {
    targetUsername: dName,
  });
  if (dmCreate.status !== 200 && dmCreate.status !== 201) {
    throw new Error(`create DM failed: ${dmCreate.status} ${JSON.stringify(dmCreate.body)}`);
  }
  const dm = dmCreate.body;

  log('setup', {
    aliceId: alice.user.id,
    bobId: bob.user.id,
    carolId: carol.user.id,
    daveId: dave.user.id,
    chatId: chat.id,
    otherId: other.id,
    soloId: solo.id,
    dmId: dm.id,
  });

  const sAlice = await openSocket(alice.token);
  const sAlice2 = await openSocket(alice.token); // alice's "other tab"
  const sBob = await openSocket(bob.token);
  const sDave = await openSocket(dave.token);
  await wait(300);

  const results = {};

  // --------------------------------------------------------------------------
  // Scenario 1 — Alice sends msg-1; Bob replies with msg-2.
  //              Ack has full replyTo ReplyPreview.

  const msg1Ack = await sendPaced(sAlice, {
    roomId: chat.id,
    body: 'hello from alice — the first message',
  });
  if (!msg1Ack.ok) throw new Error('msg1 seed failed: ' + JSON.stringify(msg1Ack));
  const msg1 = msg1Ack.message;
  await wait(100);

  const msg2Ack = await sendPaced(sBob, {
    roomId: chat.id,
    body: 'bob replying to alice',
    replyToId: msg1.id,
  });

  log('1', {
    ok: msg2Ack.ok,
    hasReplyTo: !!(msg2Ack.message && msg2Ack.message.replyTo),
    replyTo: msg2Ack.message && msg2Ack.message.replyTo,
    editedAt: msg2Ack.message && msg2Ack.message.editedAt,
  });
  results[1] = {
    expect: "ack ok=true, replyTo={id:msg1.id,userId:aliceId,username:alice,bodyPreview,createdAt}, editedAt:null",
    observed: {
      ok: msg2Ack.ok,
      replyTo: msg2Ack.message && msg2Ack.message.replyTo,
      editedAt: msg2Ack.message && msg2Ack.message.editedAt,
    },
  };
  const msg2 = msg2Ack.message;

  // --------------------------------------------------------------------------
  // Scenario 2 — Alice fetches history. msg-2 has replyTo populated; msg-1
  //              has replyTo OMITTED (NOT null) from the wire.

  const hist1 = await http('GET', `/api/rooms/${chat.id}/messages?limit=50`, alice.token);
  // Find msg-1 and msg-2
  const hist1Msg1 = hist1.body.messages.find((m) => m.id === msg1.id);
  const hist1Msg2 = hist1.body.messages.find((m) => m.id === msg2.id);
  const msg1HasReplyToKey = hist1Msg1 && Object.prototype.hasOwnProperty.call(hist1Msg1, 'replyTo');
  log('2', {
    msg1_replyToKeyPresent: msg1HasReplyToKey,
    msg2_replyTo: hist1Msg2 && hist1Msg2.replyTo,
    msg1_editedAt: hist1Msg1 && hist1Msg1.editedAt,
    msg2_editedAt: hist1Msg2 && hist1Msg2.editedAt,
  });
  results[2] = {
    expect: "msg1.replyTo OMITTED from wire, msg2.replyTo populated identically to ack, both editedAt:null",
    observed: {
      msg1_replyToKeyPresent: msg1HasReplyToKey,
      msg2_replyTo: hist1Msg2 && hist1Msg2.replyTo,
      msg1_editedAt: hist1Msg1 && hist1Msg1.editedAt,
      msg2_editedAt: hist1Msg2 && hist1Msg2.editedAt,
    },
  };

  // --------------------------------------------------------------------------
  // Scenario 3 — Cross-room replyToId. Seed a msg in #other, then attempt a
  //              reply in #chat pointing at the #other id.

  const otherMsgAck = await sendPaced(sAlice, {
    roomId: other.id,
    body: 'a message that lives in the other room',
  });
  const otherMsgId = otherMsgAck.message.id;

  const s3Ack = await sendPaced(sBob, {
    roomId: chat.id,
    body: 'cross-room reply attempt',
    replyToId: otherMsgId,
  });
  log('3', { ack: s3Ack });
  results[3] = {
    expect: "{ok:false,error:'Invalid reply target'}",
    observed: s3Ack,
  };

  // --------------------------------------------------------------------------
  // Scenario 4 — Unknown UUID replyToId.

  const s4Ack = await sendPaced(sBob, {
    roomId: chat.id,
    body: 'unknown-id reply attempt',
    replyToId: crypto.randomUUID(),
  });
  log('4', { ack: s4Ack });
  results[4] = {
    expect: "{ok:false,error:'Invalid reply target'}",
    observed: s4Ack,
  };

  // --------------------------------------------------------------------------
  // Scenario 5 — Malformed UUID replyToId → 'Invalid payload'.

  const s5Ack = await sendPaced(sBob, {
    roomId: chat.id,
    body: 'malformed uuid reply',
    replyToId: 'not-a-uuid',
  });
  log('5', { ack: s5Ack });
  results[5] = {
    expect: "{ok:false,error:'Invalid payload'}",
    observed: s5Ack,
  };

  // --------------------------------------------------------------------------
  // Scenario 6 — 200-char body target → bodyPreview exactly 140 chars, no ellipsis.

  const longBody = 'L'.repeat(200);
  const longTargetAck = await sendPaced(sAlice, {
    roomId: chat.id,
    body: longBody,
  });
  const longTargetId = longTargetAck.message.id;

  const longReplyAck = await sendPaced(sBob, {
    roomId: chat.id,
    body: 'replying to the long one',
    replyToId: longTargetId,
  });
  const bp = longReplyAck.message && longReplyAck.message.replyTo && longReplyAck.message.replyTo.bodyPreview;
  log('6', {
    bodyPreviewLen: bp ? bp.length : null,
    lastChar: bp ? bp.charAt(bp.length - 1) : null,
    endsWithEllipsis: bp ? bp.endsWith('…') || bp.endsWith('...') : null,
  });
  results[6] = {
    expect: "replyTo.bodyPreview.length === 140, no ellipsis",
    observed: {
      bodyPreviewLen: bp ? bp.length : null,
      lastChar: bp ? bp.charAt(bp.length - 1) : null,
      endsWithEllipsis: bp ? bp.endsWith('…') || bp.endsWith('...') : null,
    },
  };

  // --------------------------------------------------------------------------
  // Scenario 7 — Alice PATCHes her own message. Response 200, editedAt set.
  //              Bob's socket + Alice's other tab both receive message:edit.

  // Clear socket event buffers first.
  sBob.__edit.length = 0;
  sAlice2.__edit.length = 0;
  sAlice.__edit.length = 0;

  const beforeEdit = Date.now();
  const editRes = await http('PATCH', `/api/messages/${msg1.id}`, alice.token, {
    body: 'edited body from alice',
  });
  const editRecv = editRes.status === 200 && editRes.body.editedAt
    ? Math.abs(new Date(editRes.body.editedAt).getTime() - beforeEdit) < 5000
    : false;
  await wait(300);
  log('7', {
    status: editRes.status,
    body: editRes.body,
    editedAtWithin5s: editRecv,
    bobReceivedEdit: sBob.__edit.length,
    aliceOtherTabReceivedEdit: sAlice2.__edit.length,
    aliceEditingTabReceivedEdit: sAlice.__edit.length,
    bobEditEventPayload: sBob.__edit[0],
  });
  results[7] = {
    expect: "200 body w/ updated body + editedAt~now; broadcast received by bob + alice-other-tab + alice-editing-tab",
    observed: {
      status: editRes.status,
      body: editRes.body,
      editedAtWithin5s: editRecv,
      bobReceivedEdit: sBob.__edit.length,
      aliceOtherTabReceivedEdit: sAlice2.__edit.length,
      aliceEditingTabReceivedEdit: sAlice.__edit.length,
    },
  };

  // --------------------------------------------------------------------------
  // Scenario 8 — Bob tries to PATCH alice's message.

  const s8 = await http('PATCH', `/api/messages/${msg1.id}`, bob.token, {
    body: "bob's attempt to edit alice's msg",
  });
  log('8', { status: s8.status, body: s8.body });
  results[8] = {
    expect: "403 {error:'Only the author can edit this message'}",
    observed: s8,
  };

  // --------------------------------------------------------------------------
  // Scenario 9 — Whitespace-only body on a no-attachment message.

  const s9 = await http('PATCH', `/api/messages/${msg1.id}`, alice.token, {
    body: '   ',
  });
  log('9', { status: s9.status, body: s9.body });
  results[9] = {
    expect: "400 {error:'Body must be between 1 and 3072 characters'}",
    observed: s9,
  };

  // --------------------------------------------------------------------------
  // Scenario 10 — Whitespace-only body on a message that HAS attachments.
  //               Seed: alice uploads an image, sends a message with attachment+body,
  //               then PATCHes the body to "   " — should succeed.

  const up10 = await uploadAttachment(alice.token, {
    roomId: chat.id,
    comment: 'scn10 attachment',
    filename: 'scn10.png',
    contentType: 'image/png',
    buffer: smallPng(1024),
  });
  if (up10.status !== 201) throw new Error('scn10 upload failed: ' + JSON.stringify(up10));
  const attachSendAck = await sendPaced(sAlice, {
    roomId: chat.id,
    body: 'initial body with attachment',
    attachmentIds: [up10.body.attachment.id],
  });
  const msgAttachId = attachSendAck.message.id;

  const s10 = await http('PATCH', `/api/messages/${msgAttachId}`, alice.token, {
    body: '   ',
  });
  log('10', { status: s10.status, body: s10.body });
  results[10] = {
    expect: "200; body becomes '', editedAt set; attachments still hydrated",
    observed: {
      status: s10.status,
      body: s10.body && {
        id: s10.body.id,
        body: s10.body.body,
        editedAt: s10.body.editedAt,
        attachmentsCount: (s10.body.attachments || []).length,
      },
    },
  };

  // --------------------------------------------------------------------------
  // Scenario 11 — Over-length body.

  const hugeBody = 'x'.repeat(3073);
  const s11 = await http('PATCH', `/api/messages/${msg1.id}`, alice.token, {
    body: hugeBody,
  });
  log('11', { status: s11.status, body: s11.body });
  results[11] = {
    expect: "400 {error:'Body must be between 1 and 3072 characters'}",
    observed: s11,
  };

  // --------------------------------------------------------------------------
  // Scenario 12 — PATCH by non-member (carol). Should 404 "Message not found"
  //               to avoid leaking cross-room message existence.

  const s12 = await http('PATCH', `/api/messages/${msg1.id}`, carol.token, {
    body: "carol's forbidden edit",
  });
  log('12', { status: s12.status, body: s12.body });
  results[12] = {
    expect: "404 {error:'Message not found'}",
    observed: s12,
  };

  // --------------------------------------------------------------------------
  // Scenario 13 — PATCH random UUID.

  const s13 = await http('PATCH', `/api/messages/${crypto.randomUUID()}`, alice.token, {
    body: 'edit into the void',
  });
  log('13', { status: s13.status, body: s13.body });
  results[13] = {
    expect: "404 {error:'Message not found'}",
    observed: s13,
  };

  // --------------------------------------------------------------------------
  // Scenario 14 — PATCH in a DM with an active user-ban.

  // First — alice sends a DM message, then dave bans alice. Alice attempts edit.
  const dmMsgAck = await sendPaced(sAlice, {
    roomId: dm.id,
    body: 'hello dave, it is alice',
  });
  if (!dmMsgAck.ok) throw new Error('DM seed failed: ' + JSON.stringify(dmMsgAck));
  const dmMsgId = dmMsgAck.message.id;

  // Dave bans alice.
  const banRes = await http('POST', '/api/user-bans', dave.token, {
    userId: alice.user.id,
  });
  if (banRes.status !== 201 && banRes.status !== 200) {
    throw new Error('ban failed: ' + JSON.stringify(banRes));
  }

  const s14 = await http('PATCH', `/api/messages/${dmMsgId}`, alice.token, {
    body: 'alice trying to edit banned DM',
  });
  log('14', { status: s14.status, body: s14.body });
  results[14] = {
    expect: "403 {error:'Personal messaging is blocked'}",
    observed: s14,
  };

  // --------------------------------------------------------------------------
  // Scenario 15 — History fetch after edit: editedAt matches PATCH response
  //               on edited messages; null on unedited.

  const hist15 = await http('GET', `/api/rooms/${chat.id}/messages?limit=50`, alice.token);
  const h15Msg1 = hist15.body.messages.find((m) => m.id === msg1.id);
  const h15Msg2 = hist15.body.messages.find((m) => m.id === msg2.id);
  log('15', {
    editedMsg_editedAt: h15Msg1 && h15Msg1.editedAt,
    editedMsgBody: h15Msg1 && h15Msg1.body,
    uneditedMsg_editedAt: h15Msg2 && h15Msg2.editedAt,
  });
  results[15] = {
    expect: "edited msg editedAt === PATCH response editedAt; unedited editedAt === null",
    observed: {
      editedMsg_editedAt: h15Msg1 && h15Msg1.editedAt,
      editedMsgBody: h15Msg1 && h15Msg1.body,
      uneditedMsg_editedAt: h15Msg2 && h15Msg2.editedAt,
    },
  };

  // --------------------------------------------------------------------------
  // Scenario 16 — Alice DELETEs her own message. 204 + broadcast received by
  //               bob socket AND alice other tab.

  // Seed a fresh message alice will delete (so msg1 still exists for later).
  const delSeedAck = await sendPaced(sAlice, {
    roomId: chat.id,
    body: 'alice message marked for deletion',
  });
  const delMsgId = delSeedAck.message.id;
  sBob.__delete.length = 0;
  sAlice2.__delete.length = 0;
  sAlice.__delete.length = 0;

  const s16 = await http('DELETE', `/api/messages/${delMsgId}`, alice.token);
  await wait(300);
  log('16', {
    status: s16.status,
    body: s16.body,
    bobReceivedDelete: sBob.__delete.length,
    aliceOtherTabReceivedDelete: sAlice2.__delete.length,
    aliceDeletingTabReceivedDelete: sAlice.__delete.length,
    bobDeleteEventPayload: sBob.__delete[0],
  });
  results[16] = {
    expect: "204 no body; broadcast received by bob + alice-other + alice-deleting",
    observed: {
      status: s16.status,
      body: s16.body,
      bobReceivedDelete: sBob.__delete.length,
      aliceOtherTabReceivedDelete: sAlice2.__delete.length,
      aliceDeletingTabReceivedDelete: sAlice.__delete.length,
      bobDeleteEventPayload: sBob.__delete[0],
    },
  };

  // --------------------------------------------------------------------------
  // Scenario 17 — Bob tries to DELETE alice's message (msg2 is bob's; msg1 is alice's).

  // msg1 belongs to alice. Bob tries to delete it.
  const s17 = await http('DELETE', `/api/messages/${msg1.id}`, bob.token);
  log('17', { status: s17.status, body: s17.body });
  results[17] = {
    expect: "403 {error:'Only the author can delete this message'}",
    observed: s17,
  };

  // --------------------------------------------------------------------------
  // Scenario 18 — DELETE by non-member (carol) on msg1.

  const s18 = await http('DELETE', `/api/messages/${msg1.id}`, carol.token);
  log('18', { status: s18.status, body: s18.body });
  results[18] = {
    expect: "404 {error:'Message not found'}",
    observed: s18,
  };

  // --------------------------------------------------------------------------
  // Scenario 19 — DELETE in a DM with an active user-ban. Alice tries to
  //               delete her own DM message while banned by dave.

  const s19 = await http('DELETE', `/api/messages/${dmMsgId}`, alice.token);
  log('19', { status: s19.status, body: s19.body });
  results[19] = {
    expect: "403 {error:'Personal messaging is blocked'}",
    observed: s19,
  };

  // Unban so later scenarios aren't affected (though we don't need DM again).
  await http('DELETE', `/api/user-bans/${alice.user.id}`, dave.token);

  // --------------------------------------------------------------------------
  // Scenario 20 — DELETE a message with attachments. After delete,
  //               GET /api/attachments/:id → 404; on-disk file is gone.

  const up20 = await uploadAttachment(alice.token, {
    roomId: chat.id,
    comment: 'scn20 attach',
    filename: 'scn20.png',
    contentType: 'image/png',
    buffer: smallPng(512),
  });
  const attachId20 = up20.body.attachment.id;
  const seed20 = await sendPaced(sAlice, {
    roomId: chat.id,
    body: 'will be deleted with attachment',
    attachmentIds: [attachId20],
  });
  const msg20Id = seed20.message.id;

  const del20 = await http('DELETE', `/api/messages/${msg20Id}`, alice.token);
  // Wait briefly for the background unlink.
  await wait(500);
  const getAtt = await http('GET', `/api/attachments/${attachId20}`, alice.token);

  log('20', {
    deleteStatus: del20.status,
    getAttachmentStatus: getAtt.status,
    getAttachmentBody: getAtt.body,
  });
  results[20] = {
    expect: "DELETE 204; subsequent GET /api/attachments/:id → 404 'Attachment not found' (cascade); on-disk unlink sweep logged WARN on failure (best-effort)",
    observed: {
      deleteStatus: del20.status,
      getAttachmentStatus: getAtt.status,
      getAttachmentBody: getAtt.body,
    },
  };

  // --------------------------------------------------------------------------
  // Scenario 21 — DELETE a message that is a replyTo target. Surviving reply
  //               shows replyTo: null (NOT omitted).

  // Seed: alice sends a "target" message; bob replies. Then alice deletes the target.
  const targetAck = await sendPaced(sAlice, {
    roomId: chat.id,
    body: 'reply target that will be deleted',
  });
  const targetId = targetAck.message.id;
  const replyAck = await sendPaced(sBob, {
    roomId: chat.id,
    body: 'reply to the soon-deleted target',
    replyToId: targetId,
  });
  const replyId = replyAck.message.id;

  const del21 = await http('DELETE', `/api/messages/${targetId}`, alice.token);
  await wait(200);

  const hist21 = await http('GET', `/api/rooms/${chat.id}/messages?limit=100`, alice.token);
  const surviving = hist21.body.messages.find((m) => m.id === replyId);
  const targetGone = !hist21.body.messages.find((m) => m.id === targetId);
  const surv_replyToKeyPresent = surviving
    ? Object.prototype.hasOwnProperty.call(surviving, 'replyTo')
    : false;
  const surv_replyToValue = surviving ? surviving.replyTo : undefined;
  log('21', {
    deleteStatus: del21.status,
    targetGone,
    survivingReplyPresent: !!surviving,
    surv_replyToKeyPresent,
    surv_replyToValue,
  });
  results[21] = {
    expect: "DELETE 204; target gone from history; reply survives with replyTo === null (present-but-null)",
    observed: {
      deleteStatus: del21.status,
      targetGone,
      survivingReplyPresent: !!surviving,
      surv_replyToKeyPresent,
      surv_replyToValue,
    },
  };

  // --------------------------------------------------------------------------
  // Scenario 22 — Pagination regression. Verify hasMore, before cursor,
  //               attachments still hydrate.

  // Seed pad messages so we have > 50 total in chat.
  const needed = 60;
  for (let i = 0; i < needed; i++) {
    await sendPaced(sAlice, { roomId: chat.id, body: `pad-${i}` });
  }

  const page1 = await http('GET', `/api/rooms/${chat.id}/messages?limit=25`, alice.token);
  const p1Newest = page1.body.messages[page1.body.messages.length - 1];
  const p1Oldest = page1.body.messages[0];
  const page2 = await http(
    'GET',
    `/api/rooms/${chat.id}/messages?limit=25&before=${p1Oldest.id}`,
    alice.token,
  );

  log('22', {
    p1Status: page1.status,
    p1Len: page1.body.messages.length,
    p1HasMore: page1.body.hasMore,
    p1NewestBody: p1Newest && p1Newest.body,
    p2Status: page2.status,
    p2Len: page2.body.messages.length,
    p2HasMore: page2.body.hasMore,
    p2NewestOlderThanP1Oldest:
      page2.body.messages[page2.body.messages.length - 1].createdAt < p1Oldest.createdAt ||
      (page2.body.messages[page2.body.messages.length - 1].createdAt === p1Oldest.createdAt &&
        page2.body.messages[page2.body.messages.length - 1].id < p1Oldest.id),
  });
  results[22] = {
    expect: "hasMore semantics + before cursor strictly older + attachments hydrated unchanged",
    observed: {
      p1Status: page1.status,
      p1Len: page1.body.messages.length,
      p1HasMore: page1.body.hasMore,
      p2Status: page2.status,
      p2Len: page2.body.messages.length,
      p2HasMore: page2.body.hasMore,
    },
  };

  // --------------------------------------------------------------------------
  // Scenario 23 — message:send w/o replyToId → replyTo OMITTED (not null).

  const s23 = await sendPaced(sAlice, { roomId: chat.id, body: 'no reply here' });
  const replyToKeyPresent = Object.prototype.hasOwnProperty.call(s23.message, 'replyTo');
  log('23', {
    ok: s23.ok,
    replyToKeyPresent,
    replyToValue: s23.message.replyTo,
    editedAt: s23.message.editedAt,
  });
  results[23] = {
    expect: "message.replyTo OMITTED (hasOwnProperty false); editedAt === null (always present)",
    observed: {
      ok: s23.ok,
      replyToKeyPresent,
      replyToValue: s23.message.replyTo,
      editedAt: s23.message.editedAt,
    },
  };

  // --------------------------------------------------------------------------
  // Scenario 24 — Unread count decrement on delete.

  // Fresh room — carol joins; alice sends 3 messages.
  const unreadRoomCreate = await http('POST', '/api/rooms', alice.token, {
    name: `unread-${stamp}`,
    visibility: 'public',
  });
  const unreadRoom = unreadRoomCreate.body;
  await http('POST', `/api/rooms/${unreadRoom.id}/join`, carol.token);
  // Carol marks the room read (so her cursor is at start).
  await http('POST', `/api/rooms/${unreadRoom.id}/read`, carol.token);
  await wait(50);
  const m1a = await sendPaced(sAlice, { roomId: unreadRoom.id, body: 'unread-1' });
  const m1b = await sendPaced(sAlice, { roomId: unreadRoom.id, body: 'unread-2' });
  const m1c = await sendPaced(sAlice, { roomId: unreadRoom.id, body: 'unread-3' });

  const unread1 = await http('GET', '/api/unread', carol.token);
  const beforeRoom = (unread1.body.rooms || []).find((r) => r.roomId === unreadRoom.id);

  // Alice deletes one of them.
  const delUnread = await http('DELETE', `/api/messages/${m1b.message.id}`, alice.token);
  await wait(150);
  const unread2 = await http('GET', '/api/unread', carol.token);
  const afterRoom = (unread2.body.rooms || []).find((r) => r.roomId === unreadRoom.id);

  log('24', {
    before: beforeRoom,
    deleteStatus: delUnread.status,
    after: afterRoom,
    dropBy1: (beforeRoom && afterRoom && beforeRoom.unreadCount - afterRoom.unreadCount) === 1,
  });
  results[24] = {
    expect: "delete → next /api/unread shows unreadCount dropped by 1 for that room",
    observed: {
      before: beforeRoom,
      deleteStatus: delUnread.status,
      after: afterRoom,
    },
  };

  // --------------------------------------------------------------------------
  log('done', 'all 24 scenarios executed');

  console.log('\n\n===== SCENARIO MATRIX (raw) =====');
  for (const n of Object.keys(results).sort((a, b) => Number(a) - Number(b))) {
    console.log(`#${n} expect: ${results[n].expect}`);
    console.log(`#${n} observed: ${JSON.stringify(results[n].observed)}`);
  }

  sAlice.disconnect();
  sAlice2.disconnect();
  sBob.disconnect();
  sDave.disconnect();
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
