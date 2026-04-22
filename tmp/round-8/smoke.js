// Round 8 smoke test — attachments.
// Drives 19 scenarios against a live backend (port 3000) using node-fetch +
// socket.io-client + form-data-ish manual multipart.
//
// Captures observed HTTP bodies / socket payloads / ack strings per scenario.

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

// Minimal multipart/form-data builder — avoids adding form-data dep. Fields:
//   - `file`: { filename, contentType, buffer }
//   - other string fields are added as regular form fields.
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

async function downloadAttachment(token, id) {
  const headers = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + `/api/attachments/${id}`, { headers });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type'),
      'content-length': res.headers.get('content-length'),
      'content-disposition': res.headers.get('content-disposition'),
      'x-content-type-options': res.headers.get('x-content-type-options'),
      'cache-control': res.headers.get('cache-control'),
    },
    buffer: buf,
  };
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

async function befriend(from, to) {
  const req = await http('POST', '/api/friend-requests', from.token, {
    toUsername: to.user.username,
  });
  if (req.status !== 201) {
    throw new Error(
      `friend-request ${from.user.username} -> ${to.user.username}: ${req.status} ${JSON.stringify(req.body)}`,
    );
  }
  const accepted = await http(
    'POST',
    `/api/friend-requests/${req.body.id}/accept`,
    to.token,
  );
  if (accepted.status !== 200) {
    throw new Error(
      `accept ${req.body.id}: ${accepted.status} ${JSON.stringify(accepted.body)}`,
    );
  }
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ----------------------------------------------------------------------------
// Canned bytes.

// Smallest-plausible 8x8 PNG. Keep the bytes here verbatim so the magic-byte
// sniff and Content-Length assertions have something deterministic to hit.
function smallPng(sizeBytes = 500 * 1024) {
  // Build a buffer that starts with a valid PNG signature and is padded with
  // NUL bytes to the requested size. The magic-byte sniff only inspects the
  // first 4 bytes.
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (sizeBytes <= sig.length) return sig.slice(0, sizeBytes);
  return Buffer.concat([sig, Buffer.alloc(sizeBytes - sig.length, 0x00)]);
}

function bigBin(sizeBytes) {
  return Buffer.alloc(sizeBytes, 0x01);
}

// ----------------------------------------------------------------------------

async function main() {
  const stamp = Date.now();
  const aName = `alice_r8_${stamp}`;
  const bName = `bob_r8_${stamp}`;
  const cName = `carol_r8_${stamp}`;

  const alice = await register(aName);
  const bob = await register(bName);
  const carol = await register(cName);

  await befriend(alice, bob);

  // Channel #eng with alice + bob. Bob OWNS the channel (so alice is a
  // plain member and can leave in scenario 19 — owners cannot leave per
  // the rooms service).
  const engCreate = await http('POST', '/api/rooms', bob.token, {
    name: `eng-${stamp}`,
    visibility: 'public',
  });
  if (engCreate.status !== 201) {
    throw new Error(
      `create eng failed: ${engCreate.status} ${JSON.stringify(engCreate.body)}`,
    );
  }
  const eng = engCreate.body;
  const engJoin = await http('POST', `/api/rooms/${eng.id}/join`, alice.token);
  if (engJoin.status !== 200) {
    throw new Error(
      `alice join eng failed: ${engJoin.status} ${JSON.stringify(engJoin.body)}`,
    );
  }

  // DM alice ⇄ bob.
  const dmOpen = await http('POST', '/api/dm', alice.token, { toUserId: bob.user.id });
  if (dmOpen.status !== 201 && dmOpen.status !== 200) {
    throw new Error(
      `open dm failed: ${dmOpen.status} ${JSON.stringify(dmOpen.body)}`,
    );
  }
  const dm = dmOpen.body;

  log('setup', {
    aliceId: alice.user.id,
    bobId: bob.user.id,
    carolId: carol.user.id,
    engId: eng.id,
    dmId: dm.id,
    stamp,
  });

  // Sockets.
  const sAlice = await openSocket(alice.token);
  const sBob = await openSocket(bob.token);
  const sCarol = await openSocket(carol.token);
  await wait(200);

  // ---------------------------------------------------------------------------
  // Scenario 1 — happy-path image upload + send.
  const pngBuf = smallPng(500 * 1024);
  const up1 = await uploadAttachment(alice.token, {
    roomId: eng.id,
    comment: 'screenshot',
    filename: 'smoke.png',
    contentType: 'image/png',
    buffer: pngBuf,
  });
  const sBobMsgsBefore = sBob.__msgs.length;
  const send1 = await sendMessage(sAlice, {
    roomId: eng.id,
    body: 'here',
    attachmentIds: [up1.body.attachment.id],
  });
  await wait(200);
  log('1', {
    upload_status: up1.status,
    upload_attachment: up1.body.attachment,
    upload_has_status_field: Object.prototype.hasOwnProperty.call(
      up1.body.attachment,
      'status',
    ),
    send_ack: send1,
  });

  // ---------------------------------------------------------------------------
  // Scenario 2 — broadcast to other room member.
  const broadcastsAfter1 = sBob.__msgs.slice(sBobMsgsBefore);
  const sAliceSelfEcho = sAlice.__msgs.find((m) => m.id === send1.message.id);
  log('2', {
    bob_received: broadcastsAfter1.map((m) => ({
      id: m.id,
      roomId: m.roomId,
      body: m.body,
      attachment_kind: m.attachments?.[0]?.kind,
      attachment_id: m.attachments?.[0]?.id,
    })),
    alice_self_echo: sAliceSelfEcho ? 'present' : 'absent',
  });

  // ---------------------------------------------------------------------------
  // Scenario 3 — download as a room member.
  const dl3 = await downloadAttachment(bob.token, up1.body.attachment.id);
  log('3', {
    status: dl3.status,
    headers: dl3.headers,
    bytes_match: dl3.buffer.equals(pngBuf),
    buffer_len: dl3.buffer.length,
  });

  // ---------------------------------------------------------------------------
  // Scenario 4 — download as a non-member.
  const dl4 = await downloadAttachment(carol.token, up1.body.attachment.id);
  log('4', {
    status: dl4.status,
    body: dl4.buffer.toString('utf8'),
  });

  // ---------------------------------------------------------------------------
  // Scenario 5 — download without Bearer.
  const dl5 = await downloadAttachment(null, up1.body.attachment.id);
  log('5', {
    status: dl5.status,
    body: dl5.buffer.toString('utf8'),
  });

  // ---------------------------------------------------------------------------
  // Scenario 6 — oversize image upload (4 MB PNG).
  const up6 = await uploadAttachment(alice.token, {
    roomId: eng.id,
    filename: 'big.png',
    contentType: 'image/png',
    buffer: smallPng(4 * 1024 * 1024),
  });
  log('6', { status: up6.status, body: up6.body });

  // ---------------------------------------------------------------------------
  // Scenario 7 — oversize file upload (25 MB .bin).
  const up7 = await uploadAttachment(alice.token, {
    roomId: eng.id,
    filename: 'big.bin',
    contentType: 'application/octet-stream',
    buffer: bigBin(25 * 1024 * 1024),
  });
  log('7', { status: up7.status, body: up7.body });

  // ---------------------------------------------------------------------------
  // Scenario 8 — bad image magic (declared PNG, first bytes are JPEG).
  const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const badMagic = Buffer.concat([jpegMagic, Buffer.alloc(1024, 0x00)]);
  const up8 = await uploadAttachment(alice.token, {
    roomId: eng.id,
    filename: 'mislabeled.png',
    contentType: 'image/png',
    buffer: badMagic,
  });
  log('8', { status: up8.status, body: up8.body });

  // ---------------------------------------------------------------------------
  // Scenario 9 — non-image arbitrary file.
  const zipBuf = bigBin(10 * 1024 * 1024);
  const up9 = await uploadAttachment(alice.token, {
    roomId: eng.id,
    filename: 'demo.zip',
    contentType: 'application/zip',
    buffer: zipBuf,
  });
  log('9_upload', { status: up9.status, attachment: up9.body?.attachment });
  const dl9 = await downloadAttachment(alice.token, up9.body.attachment.id);
  log('9_download', {
    status: dl9.status,
    headers: dl9.headers,
    starts_with_attachment: dl9.headers['content-disposition']?.startsWith('attachment'),
  });

  // ---------------------------------------------------------------------------
  // Scenario 10 — over-cap attachmentIds (6).
  const sixIds = [];
  for (let i = 0; i < 6; i++) {
    const up = await uploadAttachment(alice.token, {
      roomId: eng.id,
      filename: `bulk-${i}.txt`,
      contentType: 'text/plain',
      buffer: Buffer.from(`bulk-${i}`),
    });
    if (up.status !== 201) {
      throw new Error(`bulk upload ${i} failed: ${up.status} ${JSON.stringify(up.body)}`);
    }
    sixIds.push(up.body.attachment.id);
  }
  const send10 = await sendMessage(sAlice, {
    roomId: eng.id,
    body: 'too many',
    attachmentIds: sixIds,
  });
  log('10', { ack: send10 });

  // ---------------------------------------------------------------------------
  // Scenario 11 — wrong-room attachment.
  const up11 = await uploadAttachment(alice.token, {
    roomId: dm.id,
    filename: 'dm.txt',
    contentType: 'text/plain',
    buffer: Buffer.from('hi dm'),
  });
  const send11 = await sendMessage(sAlice, {
    roomId: eng.id,
    body: 'wrong room',
    attachmentIds: [up11.body.attachment.id],
  });
  log('11', { upload_status: up11.status, ack: send11 });

  // ---------------------------------------------------------------------------
  // Scenario 12 — wrong-uploader attachment. Alice uploads; bob tries to send.
  const up12 = await uploadAttachment(alice.token, {
    roomId: eng.id,
    filename: 'alice.txt',
    contentType: 'text/plain',
    buffer: Buffer.from('alice wrote this'),
  });
  const send12 = await sendMessage(sBob, {
    roomId: eng.id,
    body: 'stealing',
    attachmentIds: [up12.body.attachment.id],
  });
  // Verify alice's upload is STILL pending — use the sweep test endpoint as a
  // cheap way to introspect: a sweep with a very large maxAgeMs (effectively
  // no-op on recent rows) leaves the row in place.
  // A direct DB lookup isn't possible from the harness without additional
  // deps; instead, ask alice to attach the same id in a fresh message — if it
  // still attaches successfully, the row was pending.
  const send12Verify = await sendMessage(sAlice, {
    roomId: eng.id,
    body: 'own it back',
    attachmentIds: [up12.body.attachment.id],
  });
  log('12', {
    ack_bob_reject: send12,
    ack_alice_rescue: send12Verify.ok === true ? 'pending-preserved' : send12Verify,
  });

  // ---------------------------------------------------------------------------
  // Scenario 13 — already-attached re-send. up1 (attached to scenario 1).
  const send13 = await sendMessage(sAlice, {
    roomId: eng.id,
    body: 'reusing',
    attachmentIds: [up1.body.attachment.id],
  });
  log('13', { ack: send13 });

  // ---------------------------------------------------------------------------
  // Scenario 14 — empty body, no attachments.
  const send14 = await sendMessage(sAlice, {
    roomId: eng.id,
    body: '',
  });
  log('14', { ack: send14 });

  // ---------------------------------------------------------------------------
  // Scenario 15 — empty body + one attachment (caption-less image).
  const up15 = await uploadAttachment(alice.token, {
    roomId: eng.id,
    filename: 'capless.png',
    contentType: 'image/png',
    buffer: smallPng(8 * 1024),
  });
  const send15 = await sendMessage(sAlice, {
    roomId: eng.id,
    body: '',
    attachmentIds: [up15.body.attachment.id],
  });
  log('15', { ack: send15 });

  // ---------------------------------------------------------------------------
  // Scenario 16 — DM ban gate on upload.
  // BEFORE the ban we first upload+send a DM attachment for scenario 17.
  const up16pre = await uploadAttachment(alice.token, {
    roomId: dm.id,
    filename: 'pre-ban.png',
    contentType: 'image/png',
    buffer: smallPng(16 * 1024),
  });
  const send16pre = await sendMessage(sAlice, {
    roomId: dm.id,
    body: 'before the ban',
    attachmentIds: [up16pre.body.attachment.id],
  });

  // Bob bans alice.
  const ban = await http('POST', '/api/user-bans', bob.token, {
    userId: alice.user.id,
  });

  const up16 = await uploadAttachment(alice.token, {
    roomId: dm.id,
    filename: 'blocked.png',
    contentType: 'image/png',
    buffer: smallPng(8 * 1024),
  });
  log('16', {
    ban_status: ban.status,
    upload_status: up16.status,
    upload_body: up16.body,
    pre_send_ack: send16pre.ok,
  });

  // ---------------------------------------------------------------------------
  // Scenario 17 — DM ban does NOT block downloads of pre-ban attachments.
  const dl17 = await downloadAttachment(alice.token, up16pre.body.attachment.id);
  log('17', {
    status: dl17.status,
    headers: dl17.headers,
    buffer_len: dl17.buffer.length,
  });

  // ---------------------------------------------------------------------------
  // Scenario 18 — orphan sweep. Upload a pending attachment, then call the
  // test-only endpoint with maxAgeMs=0 (all pending rows eligible).
  const up18 = await uploadAttachment(alice.token, {
    roomId: eng.id,
    filename: 'orphan.txt',
    contentType: 'text/plain',
    buffer: Buffer.from('this will be swept'),
  });
  const sweep = await http('POST', '/api/attachments/__sweep-for-tests', alice.token, {
    maxAgeMs: 0,
  });
  // Verify the row is gone — try to attach it; `Invalid attachment reference`
  // is the expected ack when the row no longer exists.
  const send18verify = await sendMessage(sAlice, {
    roomId: eng.id,
    body: 'after sweep',
    attachmentIds: [up18.body.attachment.id],
  });
  log('18', {
    upload_status: up18.status,
    sweep_status: sweep.status,
    sweep_body: sweep.body,
    verify_ack: send18verify,
  });

  // ---------------------------------------------------------------------------
  // Scenario 19 — uploader loses access after leaving the room.
  // Use a fresh attachment that alice uploaded + sent in #eng — up12 is good
  // since scenario 12 re-attached it via alice.
  const leavingAttachmentId = up12.body.attachment.id;
  // Alice leaves #eng.
  const leave = await http('POST', `/api/rooms/${eng.id}/leave`, alice.token);
  const dl19 = await downloadAttachment(alice.token, leavingAttachmentId);
  log('19', {
    leave_status: leave.status,
    download_status: dl19.status,
    body: dl19.buffer.toString('utf8'),
  });

  console.log('[done] all 19 scenarios executed');
  sAlice.disconnect();
  sBob.disconnect();
  sCarol.disconnect();
}

main().catch((err) => {
  console.error('smoke failed:', err);
  process.exit(1);
});
