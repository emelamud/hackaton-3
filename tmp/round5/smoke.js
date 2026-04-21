// Round 5 smoke test: 21 scenarios exercising friends + friend-requests + user-search.
// Drives HTTP via fetch, sockets via socket.io-client. Same harness shape as round4.

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
  if (status !== 201)
    throw new Error(`register ${username} failed: ${status} ${JSON.stringify(body)}`);
  return { token: body.accessToken, user: body.user };
}

async function main() {
  const stamp = Date.now();
  const aName = `alice_r5_${stamp}`;
  const bName = `bob_r5_${stamp}`;
  const cName = `carol_r5_${stamp}`;
  const a = await register(aName);
  const b = await register(bName);
  const c = await register(cName);
  log('setup', { aId: a.user.id, bId: b.user.id, cId: c.user.id, aName, bName, cName });

  // Step 1: all three connect; set up listeners.
  const aSock = await socket(a.token);
  const bSock = await socket(b.token);
  const cSock = await socket(c.token);

  const aRejected = collect(aSock, 'friend:request:rejected');
  const aRemoved = collect(aSock, 'friend:removed');
  const aAccepted = collect(aSock, 'friend:request:accepted');
  const bNew = collect(bSock, 'friend:request:new');
  const bCancelled = collect(bSock, 'friend:request:cancelled');
  const bAccepted = collect(bSock, 'friend:request:accepted');
  const bRemoved = collect(bSock, 'friend:removed');
  const cNew = collect(cSock, 'friend:request:new');
  const cCancelled = collect(cSock, 'friend:request:cancelled');
  log('1', 'A, B, C sockets connected; listeners attached');

  // Step 2: A searches for "b" — expect at least B; self-exclusion required.
  // Use a unique-enough prefix to avoid polluting the output with other users.
  const step2 = await http('GET', `/api/users/search?q=${encodeURIComponent(bName.slice(0, 8))}`, a.token);
  const step2B = Array.isArray(step2.body)
    ? step2.body.find((r) => r.username === bName)
    : null;
  const step2Self = Array.isArray(step2.body)
    ? step2.body.find((r) => r.username === aName)
    : null;
  log('2', {
    status: step2.status,
    count: Array.isArray(step2.body) ? step2.body.length : null,
    bEntry: step2B,
    selfIncluded: Boolean(step2Self),
  });

  // Step 3: A tries to send to self.
  const step3 = await http('POST', '/api/friend-requests', a.token, {
    toUsername: aName,
  });
  log('3', { status: step3.status, body: step3.body });

  // Step 4: A sends to ghost.
  const step4 = await http('POST', '/api/friend-requests', a.token, {
    toUsername: 'ghost_nonexistent_user_9999',
  });
  log('4', { status: step4.status, body: step4.body });

  // Step 5: A sends to B with a message.
  const step5 = await http('POST', '/api/friend-requests', a.token, {
    toUsername: bName,
    message: 'hey bob',
  });
  await new Promise((r) => setTimeout(r, 200));
  log('5.http', { status: step5.status, body: step5.body });
  log('5.socket.bNew.count', bNew.length);
  log('5.socket.bNew.payload', bNew[0] || null);
  const reqId = step5.body.id;

  // Step 6: A repeats same request — 409 pending.
  const step6 = await http('POST', '/api/friend-requests', a.token, {
    toUsername: bName,
  });
  log('6', { status: step6.status, body: step6.body });

  // Step 7: B attempts reverse-direction request — 409 pending (unordered-pair).
  const step7 = await http('POST', '/api/friend-requests', b.token, {
    toUsername: aName,
  });
  log('7', { status: step7.status, body: step7.body });

  // Step 8: A search for B — relationship 'outgoing_pending'.
  const step8 = await http('GET', `/api/users/search?q=${encodeURIComponent(bName.slice(0, 8))}`, a.token);
  const step8B = Array.isArray(step8.body)
    ? step8.body.find((r) => r.username === bName)
    : null;
  log('8', { status: step8.status, bEntry: step8B });

  // Step 9: B search for A — relationship 'incoming_pending'.
  const step9 = await http('GET', `/api/users/search?q=${encodeURIComponent(aName.slice(0, 8))}`, b.token);
  const step9A = Array.isArray(step9.body)
    ? step9.body.find((r) => r.username === aName)
    : null;
  log('9', { status: step9.status, aEntry: step9A });

  // Step 10: both lists.
  const step10incoming = await http('GET', '/api/friend-requests/incoming', b.token);
  const step10outgoing = await http('GET', '/api/friend-requests/outgoing', a.token);
  log('10.incoming', {
    status: step10incoming.status,
    count: Array.isArray(step10incoming.body) ? step10incoming.body.length : null,
    firstId: Array.isArray(step10incoming.body) && step10incoming.body[0] ? step10incoming.body[0].id : null,
  });
  log('10.outgoing', {
    status: step10outgoing.status,
    count: Array.isArray(step10outgoing.body) ? step10outgoing.body.length : null,
    firstId: Array.isArray(step10outgoing.body) && step10outgoing.body[0] ? step10outgoing.body[0].id : null,
  });

  // Step 11: B accepts — both sides fire.
  aAccepted.length = 0;
  bAccepted.length = 0;
  const step11 = await http('POST', `/api/friend-requests/${reqId}/accept`, b.token);
  await new Promise((r) => setTimeout(r, 300));
  log('11.http', { status: step11.status, body: step11.body });
  log('11.socket.bAccepted', bAccepted[0] || null);
  log('11.socket.aAccepted', aAccepted[0] || null);

  // Step 12: both sides GET /api/friends.
  const step12A = await http('GET', '/api/friends', a.token);
  const step12B = await http('GET', '/api/friends', b.token);
  log('12.A', {
    status: step12A.status,
    friends: Array.isArray(step12A.body) ? step12A.body : null,
  });
  log('12.B', {
    status: step12B.status,
    friends: Array.isArray(step12B.body) ? step12B.body : null,
  });

  // Step 13: search B again, relationship 'friend'.
  const step13 = await http('GET', `/api/users/search?q=${encodeURIComponent(bName.slice(0, 8))}`, a.token);
  const step13B = Array.isArray(step13.body)
    ? step13.body.find((r) => r.username === bName)
    : null;
  log('13', { status: step13.status, bEntry: step13B });

  // Step 14: A tries to send another request to existing friend B.
  const step14 = await http('POST', '/api/friend-requests', a.token, {
    toUsername: bName,
  });
  log('14', { status: step14.status, body: step14.body });

  // Step 15: A sends to C.
  const step15 = await http('POST', '/api/friend-requests', a.token, {
    toUsername: cName,
  });
  await new Promise((r) => setTimeout(r, 200));
  log('15.http', { status: step15.status, body: step15.body });
  log('15.socket.cNew', cNew[0] || null);
  const reqId15 = step15.body.id;

  // Step 16: A cancels request to C.
  cCancelled.length = 0;
  const step16 = await http('DELETE', `/api/friend-requests/${reqId15}`, a.token);
  await new Promise((r) => setTimeout(r, 200));
  log('16.http', { status: step16.status, body: step16.body });
  log('16.socket.cCancelled', cCancelled[0] || null);

  // Step 17: A invites C again, C rejects.
  cNew.length = 0;
  aRejected.length = 0;
  const step17send = await http('POST', '/api/friend-requests', a.token, {
    toUsername: cName,
  });
  const reqId17 = step17send.body.id;
  await new Promise((r) => setTimeout(r, 200));
  log('17.send', { status: step17send.status, cNewCount: cNew.length });

  // Collector for "no event to C" confirmation (listen for rejected on C, expect 0).
  const cRejected = collect(cSock, 'friend:request:rejected');
  cRejected.length = 0;

  const step17reject = await http('POST', `/api/friend-requests/${reqId17}/reject`, c.token);
  await new Promise((r) => setTimeout(r, 300));
  log('17.reject.http', { status: step17reject.status, body: step17reject.body });
  log('17.socket.aRejected', aRejected[0] || null);
  log('17.socket.cRejected.count', cRejected.length);

  // Step 18: A removes B friendship.
  bRemoved.length = 0;
  const step18del = await http('DELETE', `/api/friends/${b.user.id}`, a.token);
  await new Promise((r) => setTimeout(r, 200));
  log('18.del.http', { status: step18del.status, body: step18del.body });
  log('18.socket.bRemoved', bRemoved[0] || null);
  const step18aList = await http('GET', '/api/friends', a.token);
  const step18bList = await http('GET', '/api/friends', b.token);
  log('18.aList', {
    status: step18aList.status,
    friends: Array.isArray(step18aList.body) ? step18aList.body : null,
  });
  log('18.bList', {
    status: step18bList.status,
    friends: Array.isArray(step18bList.body) ? step18bList.body : null,
  });

  // Step 19: A removes B again — 404 Not a friend.
  const step19 = await http('DELETE', `/api/friends/${b.user.id}`, a.token);
  log('19', { status: step19.status, body: step19.body });

  // Step 20: Permissions — A creates request to B, C attempts to accept.
  const step20send = await http('POST', '/api/friend-requests', a.token, {
    toUsername: bName,
  });
  const reqId20 = step20send.body.id;
  log('20.send', { status: step20send.status });
  const step20cAccept = await http('POST', `/api/friend-requests/${reqId20}/accept`, c.token);
  log('20.c.accept', { status: step20cAccept.status, body: step20cAccept.body });
  const step20bReject = await http('POST', `/api/friend-requests/${reqId20}/reject`, b.token);
  log('20.b.reject', { status: step20bReject.status, body: step20bReject.body });

  // Step 21: Search validation.
  const step21empty = await http('GET', '/api/users/search?q=', a.token);
  log('21.empty', { status: step21empty.status, body: step21empty.body });

  const step21single = await http('GET', '/api/users/search?q=a', a.token);
  log('21.single', { status: step21single.status, body: step21single.body });

  const longQ = 'x'.repeat(70);
  const step21long = await http('GET', `/api/users/search?q=${longQ}`, a.token);
  log('21.long', { status: step21long.status, body: step21long.body });

  const step21aOk = await http('GET', `/api/users/search?q=${encodeURIComponent(aName.slice(0, 8))}`, a.token);
  log('21.aOk', {
    status: step21aOk.status,
    count: Array.isArray(step21aOk.body) ? step21aOk.body.length : null,
  });

  aSock.close();
  bSock.close();
  cSock.close();
  console.log('\n=== SMOKE DONE ===');
  process.exit(0);
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
