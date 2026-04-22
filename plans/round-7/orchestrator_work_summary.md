# Round 7 — Orchestrator Work Summary

## Built

**Shared types (`/shared/types/`)**

- `presence.ts` — NEW file. Exports `PresenceState = 'online' | 'afk' | 'offline'`, `UserPresence`, `PresenceUpdatePayload`, `PresenceSnapshotPayload`.
- `index.ts` — added `export * from './presence';` between `./user-ban` and `./socket` so downstream barrel imports resolve.
- `socket.ts` — imported `PresenceUpdatePayload`, `PresenceSnapshotPayload`; added `'presence:update'` and `'presence:snapshot'` to `ServerToClientEvents`. NEW `ClientToServerEvents` interface with `'presence:active'` and `'presence:idle'`. `ClientToServerEvent` type alias added alongside the existing `ServerToClientEvent`. `message:send` deliberately NOT added to `ClientToServerEvents` — it uses an ack callback + separate `SendMessagePayload` / `MessageSendAck` typing pair and migrating is low-value churn for this round (commented inline in the file).

**API contract (`/shared/api-contract.md`)**

- `### On connect` (Socket Events → Transport → On connect) — extended with a new step 3: server emits `presence:snapshot` to the newly-connected socket after the `user:<userId>` + `room:<roomId>` joins; note that the newly-connected socket starts with per-socket activity `active` and triggers a `presence:update` broadcast to the interest set if that transitions the user's aggregate state.
- `### Client → Server events` — added two new event subsections after the existing `#### message:send` block:
  - `#### presence:active` — no payload; fired on `idle → active` tab transitions.
  - `#### presence:idle` — no payload; fired on `active → idle` tab transitions (60,000 ms timer OR `visibilitychange → hidden`).
- NEW `### Presence rules (Round 7)` block — enumerates the 60 s AFK threshold; the list of qualifying DOM interaction events; the server aggregation rule (online / afk / offline); the "transitions only → broadcast" rule; the interest-set definition (friends ∪ DM peers ∪ room co-members); the ≤ 2 s latency target.
- `### Server → Client events` — added two new event blocks between the existing `user:ban:removed` and `### Error envelope`:
  - `#### presence:update` — payload `PresenceUpdatePayload`, fan-out to `user:<interestedUserId>` on aggregate transition, self-exclusion documented.
  - `#### presence:snapshot` — payload `PresenceSnapshotPayload`, per-socket direct emit (not user fan-out), consumer merge semantics documented.

**Agent descriptions (`.claude/agents/`)**

- `backend-developer.md` — added a one-liner under `## Source of truth`: "For socket events, `shared/types/socket.ts` is authoritative (both `ServerToClientEvents` and `ClientToServerEvents`) — do not invent new event names, and prefer `emitToUser` / `emitToRoom` from `backend/src/socket/io.ts` over hand-rolled `io.in(...).emit(...)`." Closes the drift loop flagged in Round 5 + Round 6 summaries.
- `frontend-developer.md` — symmetric one-liner: "For socket events, `shared/types/socket.ts` is the contract — event names and payload shapes must match. Outgoing client events are typed via `ClientToServerEvents`; incoming via `ServerToClientEvents`."

**Design-decision rationale captured in the contract** (per the planning Q&A, Q1–Q10):

- Q1 — AFK threshold = 60,000 ms client-side (requirement §2.2.2). Locked in `### Presence rules`.
- Q2 — Qualifying DOM events list enumerated in `### Presence rules`.
- Q3 — Root-scoped service attachment is an FE architectural choice; not in the contract. Lives in the FE task file.
- Q4 — Testing strategy (BE smoke + FE Playwright exercise) is out of contract.
- Q5 — Separate `presence:active` / `presence:idle` events (not a heartbeat). Captured in the `### Client → Server events` subsections.
- Q6 — Aggregation rule (online iff any active socket; afk iff all sockets idle; offline iff no sockets). Captured in `### Presence rules`.
- Q7 — Interest set = friends ∪ DM peers ∪ room co-members. Captured in `### Presence rules`; self-exclusion noted on `presence:update`.
- Q8 — Snapshot-on-connect is per-socket, not per-user. Captured on the `presence:snapshot` block.
- Q9 — Reconnect flash accepted trade-off; grace-period polish deferred. Captured in **Config improvements** below.
- Q10 — User sees own dot via local `PresenceActivityService.selfState`; server never emits self-fan-out. Captured on `presence:update` ("NOT fired to the changed user themselves").

## Deviations

1. **`ClientToServerEvents` entries typed as `() => void`, not bare `void`.** The task file suggested `'presence:active': void` / `'presence:idle': void`. At the Socket.io typings layer, event values must be function signatures — `Server<ClientToServerEvents, ServerToClientEvents>` generic expects each event's value to be callable. Using bare `void` would cause the `Server` generic to reject the shape. Using `() => void` matches the socket.io convention and still resolves to "no payload, no ack". Functionally identical for the emit/on sites; fixed at the type layer.

   BE and FE do not need to special-case this — `socket.emit('presence:active')` and `socket.on('presence:active', () => …)` type-check cleanly under either form. The only observable difference is the generic parameter of `new Server<CTS, STC>()` in `backend/src/socket/io.ts` (now valid) or `io<CTS, STC>(url, …)` in the FE socket service.

2. **`### On connect` step 3 added** (task 4c housekeeping recommended as optional; I added it since the `presence:snapshot` semantics are otherwise only documented on the event block itself, and connect-time behaviour is a natural place for a cross-reference). No contract impact — purely docs.

No shape changes to `Room`, `User`, `Friend`, `UserBan`, `Invitation`, `Message`, etc. Presence is the first round that adds a new client → server surface, so the `ClientToServerEvents` introduction is the only structural change to `socket.ts`.

## Deferred

- **Grace-period flash smoothing on disconnect** — a brief `offline` flash on network-blip reconnects is accepted under the 2 s propagation target. Captured in **Config improvements**.
- **Server-driven AFK timers** — we lock client-driven transitions. If a client disconnects without sending `presence:idle`, the disconnect itself flushes the socket to offline (no AFK middle state), which is correct.
- **HTTP `/api/presence/*` endpoint** — deliberate: presence is a Socket.io-only surface. The `presence:snapshot` event covers initial-state fetch.
- **`message:send` migration into `ClientToServerEvents`** — low-value typing churn; the existing ad-hoc signature works. Flag for a future typing pass.
- **Own-user fan-out from server** — the user does NOT receive their own `presence:update`. Multi-tab own-dot sync is handled by the FE's `PresenceActivityService.selfState` signal, which every tab updates independently from the same interaction events. Not a contract deferral per se — this is the locked design.
- **Typing indicators / "last seen at" timestamps** — not in requirements. Unscheduled.
- **Integration tests** — carry-over from every prior round.

## Next round needs to know

**For Round 8 (attachments)** — no presence coupling. The DM-ban gate on `message:send` already blocks sends from a blocked user; any separate `POST /api/rooms/:id/attachments` endpoint must replicate the `hasBanBetween` check (already flagged in Round 6's summary; still applies).

**For Round 9 (pagination)** — no presence coupling.

**For Round 11 (moderation)** — when an admin removes a member from a room, the removed user's co-membership edge is gone. The NEXT time either user's presence transitions, the interest-set query (`getInterestSet`) will naturally return the new set — no explicit edge-invalidation step needed. The Round-11 planner should NOT over-engineer an explicit `presence:recompute-interest` event; the lazy recomputation is the locked design.

**For Round 12 (unread + public catalog)** — no presence coupling. The sidebar unread badge will render next to, not on top of, the presence dot — the two affordances occupy different slots on the row.

**Contract-level**
- `ClientToServerEvents` is now live. Future rounds that add client → server events (e.g. typing indicators, if ever scheduled) should extend `shared/types/socket.ts` rather than reintroduce ad-hoc typings.
- `PresenceState` is a literal union; any future addition (`'away'`, `'busy'`, etc.) is a breaking change — enumerate call-sites on the FE before widening.

## Config improvements

- **Grace-period hold on last-socket disconnect** — a 5 s debounce before emitting `offline` after the last socket drops would smooth network-blip flashes and bring us well under the 2 s latency target for legitimate offline transitions (requirement §3.2). Small change to `presence.service.ts` (hold a pending `setTimeout` keyed on userId; cancel it on reconnect). Deferred to a polish pass.
- **`message:send` into `ClientToServerEvents`** — the current ad-hoc `socket.on('message:send', (payload, ack) => …)` typing in `backend/src/socket/io.ts` predates this round's introduction of `ClientToServerEvents`. Migrating would align the typing surface but requires threading the ack callback through the generic, which is extra complexity for no runtime change. Low priority; flag for a dedicated typing pass.
- **`Room.name` / `Room.ownerId` → discriminated union `Channel | Dm`** — still relevant from Round 6; presence doesn't read either field, but every round that DOES read them has to re-audit. Candidate for a type-hygiene cleanup around Round 12.
- **Dedicated `/presence` Socket.io namespace** — at 300-user scale the single default namespace is fine. If presence fan-out ever becomes a hot path, a dedicated namespace would let us segregate its lifecycle from message / invitation traffic. Post-hackathon concern.
- **Pagination on `presence:snapshot`** — a user with a very large interest set (many rooms with many co-members) gets a single large payload on connect. At hackathon scale this is bounded by §3.1's typical-user sizing (20 rooms, 50 contacts). Post-hackathon.
- **Drop forward-references in API contract** — housekeeping grep confirmed the existing `Round 3/4/5/6/9/11` forward-references are still accurate. No cleanup needed in Round 7.
