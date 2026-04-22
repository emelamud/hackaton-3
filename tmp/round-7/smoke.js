// Round 7 smoke test — presence engine.
// Drives 12 scenarios against live backend (port 3000) using node-fetch + socket.io-client.
// Captures observed `presence:snapshot` and `presence:update` payloads per scenario.

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

function openSocket(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
    // Capture BOTH events before `connect` resolves so we never miss the snapshot.
    s.__snapshots = [];
    s.__updates = [];
    s.on('presence:snapshot', (p) => s.__snapshots.push(p));
    s.on('presence:update', (p) => s.__updates.push(p));
    s.once('connect', () => resolve(s));
    s.once('connect_error', (e) => reject(e));
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
  const accepted = await http('POST', `/api/friend-requests/${req.body.id}/accept`, to.token);
  if (accepted.status !== 200) {
    throw new Error(`accept ${req.body.id}: ${accepted.status} ${JSON.stringify(accepted.body)}`);
  }
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Small helper — snapshot the current length of an events array, await a delay,
// then return the slice added in between.
async function diff(arr, after) {
  const before = arr.length;
  await after();
  await wait(200);
  return arr.slice(before);
}

async function main() {
  const stamp = Date.now();
  const aName = `alice_r7_${stamp}`;
  const bName = `bob_r7_${stamp}`;
  const cName = `carol_r7_${stamp}`;

  const alice = await register(aName);
  const bob = await register(bName);
  const carol = await register(cName);
  log('setup', {
    aId: alice.user.id,
    bId: bob.user.id,
    cId: carol.user.id,
    stamp,
  });

  // ---------------------------------------------------------------------------
  // Scenario 1 — alice alone (no friends, no rooms, no DMs). Expect empty snapshot.
  const S1 = await openSocket(alice.token);
  await wait(200);
  const s1Snap = S1.__snapshots[0];
  log('1', {
    S1_snapshot: s1Snap,
    assertEmpty: Array.isArray(s1Snap?.presences) && s1Snap.presences.length === 0,
  });

  // ---------------------------------------------------------------------------
  // Scenario 2 — make alice and bob friends, then bob connects.
  // Expected: S2 snapshot contains alice=online; S1 receives presence:update for bob=online.
  await befriend(alice, bob);
  // After befriending, alice's existing S1 doesn't know about the new edge until
  // her NEXT aggregate-state transition. That's fine — scenario 2 asserts the
  // bob->alice broadcast path which is triggered on bob's connect.
  const s1UpdatesBeforeBob = S1.__updates.length;
  const S2 = await openSocket(bob.token);
  await wait(300);
  const s2Snap = S2.__snapshots[0];
  const s1UpdatesAfterBob = S1.__updates.slice(s1UpdatesBeforeBob);
  log('2', {
    S2_snapshot: s2Snap,
    S2_snapshot_has_alice_online: s2Snap?.presences?.some(
      (p) => p.userId === alice.user.id && p.state === 'online',
    ),
    S1_updates_for_bob: s1UpdatesAfterBob.filter((u) => u.userId === bob.user.id),
  });

  // ---------------------------------------------------------------------------
  // Scenario 3 — alice opens tab2.
  // Expected: S3 snapshot has bob=online; NO presence:update broadcast to bob (alice stays online);
  //           NO self-fan-out to S1.
  const s2UpdatesBefore = S2.__updates.length;
  const s1UpdatesBefore3 = S1.__updates.length;
  const S3 = await openSocket(alice.token);
  await wait(300);
  const s3Snap = S3.__snapshots[0];
  const s2UpdatesFromAlice = S2.__updates
    .slice(s2UpdatesBefore)
    .filter((u) => u.userId === alice.user.id);
  const s1UpdatesForSelf = S1.__updates
    .slice(s1UpdatesBefore3)
    .filter((u) => u.userId === alice.user.id);
  log('3', {
    S3_snapshot: s3Snap,
    S3_has_bob_online: s3Snap?.presences?.some(
      (p) => p.userId === bob.user.id && p.state === 'online',
    ),
    S2_updates_for_alice: s2UpdatesFromAlice,
    S1_self_updates: s1UpdatesForSelf,
  });

  // ---------------------------------------------------------------------------
  // Scenario 4 — S1 goes idle. S3 still active → aggregate stays `online`.
  // Expected: no broadcast to bob.
  const s2UpdatesBefore4 = S2.__updates.length;
  S1.emit('presence:idle');
  await wait(300);
  const s2UpdatesForAlice4 = S2.__updates
    .slice(s2UpdatesBefore4)
    .filter((u) => u.userId === alice.user.id);
  log('4', {
    S2_updates_for_alice: s2UpdatesForAlice4,
  });

  // ---------------------------------------------------------------------------
  // Scenario 5 — S3 also goes idle → aggregate flips to `afk`. Bob should receive update.
  const s2UpdatesBefore5 = S2.__updates.length;
  S3.emit('presence:idle');
  await wait(300);
  const s2UpdatesForAlice5 = S2.__updates
    .slice(s2UpdatesBefore5)
    .filter((u) => u.userId === alice.user.id);
  log('5', {
    S2_updates_for_alice: s2UpdatesForAlice5,
    expect: "{ userId: alice, state: 'afk' }",
  });

  // ---------------------------------------------------------------------------
  // Scenario 6 — S1 goes active → aggregate back to `online`.
  const s2UpdatesBefore6 = S2.__updates.length;
  S1.emit('presence:active');
  await wait(300);
  const s2UpdatesForAlice6 = S2.__updates
    .slice(s2UpdatesBefore6)
    .filter((u) => u.userId === alice.user.id);
  log('6', {
    S2_updates_for_alice: s2UpdatesForAlice6,
    expect: "{ userId: alice, state: 'online' }",
  });

  // ---------------------------------------------------------------------------
  // Scenario 7 — alice disconnects S1 (which is `active`). S3 is `idle`.
  // Expected variant: since S1 was the sole active socket, aggregate flips online -> afk → bob receives update.
  const s2UpdatesBefore7 = S2.__updates.length;
  S1.disconnect();
  await wait(300);
  const s2UpdatesForAlice7 = S2.__updates
    .slice(s2UpdatesBefore7)
    .filter((u) => u.userId === alice.user.id);
  log('7', {
    S2_updates_for_alice: s2UpdatesForAlice7,
    expect: "{ userId: alice, state: 'afk' } (S1 was sole active; S3 still idle)",
  });

  // ---------------------------------------------------------------------------
  // Scenario 8 — alice disconnects S3 (last socket gone) → state=offline.
  const s2UpdatesBefore8 = S2.__updates.length;
  S3.disconnect();
  await wait(300);
  const s2UpdatesForAlice8 = S2.__updates
    .slice(s2UpdatesBefore8)
    .filter((u) => u.userId === alice.user.id);
  log('8', {
    S2_updates_for_alice: s2UpdatesForAlice8,
    expect: "{ userId: alice, state: 'offline' }",
  });

  // ---------------------------------------------------------------------------
  // Scenario 9 — carol connects; she has no relationship with alice or bob.
  // Expected: carol's snapshot is empty; bob does NOT get any carol update; a
  // fresh alice socket (S1') does NOT receive any carol update either.
  const s2UpdatesBefore9 = S2.__updates.length;
  const S4 = await openSocket(carol.token);
  await wait(300);
  const s4Snap = S4.__snapshots[0];
  const s2UpdatesAboutCarol = S2.__updates
    .slice(s2UpdatesBefore9)
    .filter((u) => u.userId === carol.user.id);
  // Re-connect alice on a fresh socket to verify she also receives nothing about carol.
  const S1p = await openSocket(alice.token);
  await wait(300);
  const s1pUpdatesAboutCarol = S1p.__updates.filter((u) => u.userId === carol.user.id);
  log('9', {
    S4_snapshot: s4Snap,
    S2_updates_about_carol: s2UpdatesAboutCarol,
    S1prime_updates_about_carol: s1pUpdatesAboutCarol,
  });

  // ---------------------------------------------------------------------------
  // Scenario 10 — room co-membership expands the interest set.
  // alice creates a public channel, carol joins. carol's interest set should
  // now include alice. Alice goes idle → broadcast reaches carol's S4.
  const channel = await http('POST', '/api/rooms', alice.token, {
    name: `r7_channel_${stamp}`,
    description: 'round-7 channel',
    visibility: 'public',
  });
  if (channel.status !== 201) {
    throw new Error(`create channel failed: ${channel.status} ${JSON.stringify(channel.body)}`);
  }
  const carolJoin = await http('POST', `/api/rooms/${channel.body.id}/join`, carol.token);
  if (carolJoin.status !== 200) {
    throw new Error(`carol join failed: ${carolJoin.status} ${JSON.stringify(carolJoin.body)}`);
  }
  // Alice goes idle via S1' (currently `active`). Aggregate flips online → afk because
  // S1' is her only live socket. Carol should receive the update.
  const s4UpdatesBefore10 = S4.__updates.length;
  const s2UpdatesBefore10 = S2.__updates.length;
  S1p.emit('presence:idle');
  await wait(300);
  const s4UpdatesForAlice10 = S4.__updates
    .slice(s4UpdatesBefore10)
    .filter((u) => u.userId === alice.user.id);
  const s2UpdatesForAlice10 = S2.__updates
    .slice(s2UpdatesBefore10)
    .filter((u) => u.userId === alice.user.id);
  log('10', {
    S4_updates_for_alice_after_join: s4UpdatesForAlice10,
    S2_updates_for_alice_after_join: s2UpdatesForAlice10,
    expect:
      'S4 sees { alice, afk } because carol is now a co-member; S2 also sees it because bob is still a friend.',
  });

  // ---------------------------------------------------------------------------
  // Scenario 11 — DM between alice and bob collapses duplicate interest edges.
  // Open DM; verify the subsequent alice transition delivers EXACTLY ONE update to bob
  // (no duplicate even though bob is both a friend AND a DM co-member).
  const dm = await http('POST', '/api/dm', alice.token, { toUserId: bob.user.id });
  if (dm.status !== 201 && dm.status !== 200) {
    throw new Error(`open DM failed: ${dm.status} ${JSON.stringify(dm.body)}`);
  }
  await wait(200);
  const s2UpdatesBefore11 = S2.__updates.length;
  S1p.emit('presence:active');
  await wait(300);
  const s2UpdatesForAlice11 = S2.__updates
    .slice(s2UpdatesBefore11)
    .filter((u) => u.userId === alice.user.id);
  log('11', {
    S2_updates_for_alice_after_DM: s2UpdatesForAlice11,
    count: s2UpdatesForAlice11.length,
    expect: 'exactly 1 update even though bob is both friend AND DM peer',
  });

  // ---------------------------------------------------------------------------
  // Scenario 12 — page-hidden immediate idle. Simulate visibility-change by
  // emitting `presence:idle` within 5s of connect; the server response is the
  // same as a normal idle transition.
  const freshAlice = await register(`alice12_r7_${stamp}`);
  const freshBob = await register(`bob12_r7_${stamp}`);
  await befriend(freshAlice, freshBob);
  const Sb = await openSocket(freshBob.token);
  const Sa = await openSocket(freshAlice.token);
  await wait(300);
  const sbUpdatesBefore12 = Sb.__updates.length;
  // Immediately go idle (simulates tab becoming hidden).
  Sa.emit('presence:idle');
  await wait(300);
  const sbUpdatesForFreshAlice12 = Sb.__updates
    .slice(sbUpdatesBefore12)
    .filter((u) => u.userId === freshAlice.user.id);
  log('12', {
    Sb_updates_for_freshAlice: sbUpdatesForFreshAlice12,
    expect: "{ state: 'afk' } after simulated visibility-change",
  });

  // Cleanup.
  S2.disconnect();
  S4.disconnect();
  S1p.disconnect();
  Sa.disconnect();
  Sb.disconnect();
  log('done', 'all 12 scenarios executed');
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
