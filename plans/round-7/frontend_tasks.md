# Round 7 — Frontend Tasks

## Goal
Render online / AFK / offline presence dots next to friends, DM rows, DM headers, and room member rail entries. Detect the local tab's activity via DOM events + Page Visibility API, report `presence:active` / `presence:idle` transitions to the server, and consume `presence:snapshot` / `presence:update` events to drive the UI map.

## Dependencies
- `shared/types/presence.ts` + `shared/types/socket.ts` (Round 7 orchestrator output — `PresenceState`, `UserPresence`, `PresenceUpdatePayload`, `PresenceSnapshotPayload`, the new client→server events).
- `shared/api-contract.md` §Socket Events — the Round 7 additions lock the event names, payload shapes, snapshot-on-connect semantics, and the AFK threshold (60 s).
- Existing infra: `frontend/src/app/core/socket/socket.service.ts` (typed wrapper around socket.io-client); `frontend/src/app/core/auth/auth.service.ts` (service-lifecycle hooks — `fetchInitial`/`reset` pattern); `frontend/src/app/chat/rooms-sidebar.component.*` (friend + DM rows — presence slot reserved in Round 6); `frontend/src/app/chat/room-view.component.*` (DM header — presence slot reserved); `frontend/src/app/chat/room-rail.component.*` (member rail).
- `plans/round-6/frontend_work_summary.md` §Next round needs to know — DM sidebar row presence slot lives to the LEFT of the avatar; DM header slot lives to the LEFT of `@username`; ban-lock icon renders adjacent to — not instead of — the presence dot slot.
- `.claude/skills/design-system/SKILL.md` + `frontend/docs/DESIGN_SYSTEM.md` — no hex / no `--mat-sys-*` in templates / no `px` / utility classes only.
- `.claude/agents/frontend-developer.md` — Angular 20 standalone, signals, ReactiveFormsModule, `inject()` in factories.
- **Do not modify `/shared/`.** Report any type or contract change needed.

## Tasks

### 1. New service — `frontend/src/app/core/presence/presence.service.ts`

Root-scoped (`providedIn: 'root'`). Holds the server-sourced presence map + exposes a per-userId reactive lookup:

```ts
@Injectable({ providedIn: 'root' })
export class PresenceService {
  private readonly socket = inject(SocketService);
  private readonly auth = inject(AuthService);

  // Signal holding the full presence map. Keyed by userId.
  readonly presences = signal<ReadonlyMap<string, PresenceState>>(new Map());

  constructor() {
    this.socket.on('presence:snapshot', (payload: PresenceSnapshotPayload) => {
      // Merge-in, don't replace — preserves entries from prior connections / late updates.
      const next = new Map(this.presences());
      for (const { userId, state } of payload.presences) next.set(userId, state);
      this.presences.set(next);
    });

    this.socket.on('presence:update', ({ userId, state }: PresenceUpdatePayload) => {
      const next = new Map(this.presences());
      next.set(userId, state);
      this.presences.set(next);
    });
  }

  /** Reactive lookup — returns the peer's state, or 'offline' if unknown. */
  stateFor(userId: string): Signal<PresenceState> {
    return computed(() => this.presences().get(userId) ?? 'offline');
  }

  reset(): void {
    this.presences.set(new Map());
  }
}
```

Notes:
- The service does NOT know about the own-user. Own-user state is layered in `PresenceActivityService` (task 2) — the server never sends self-updates, and self-state lives locally in the activity tracker.
- `stateFor(userId)` returns a computed signal — each component that renders a dot gets its own lightweight reactive handle.
- `reset()` is called from `AuthService.clearSession` on logout — follow the same pattern as `FriendsService.reset`, `UserBansService.reset`.

### 2. New service — `frontend/src/app/core/presence/presence-activity.service.ts`

Root-scoped. Owns the activity tracker + emits `presence:active` / `presence:idle` to the server on transitions. Also exposes a local self-state signal for rendering the own dot.

```ts
@Injectable({ providedIn: 'root' })
export class PresenceActivityService {
  private readonly socket = inject(SocketService);
  private readonly zone = inject(NgZone);
  private readonly document = inject(DOCUMENT);

  private readonly AFK_MS = 60_000;
  private readonly EVENTS = ['mousedown', 'mousemove', 'wheel', 'scroll', 'keydown', 'pointerdown', 'touchstart'] as const;

  // Local self-state — used by the member rail + DM header to render the own dot.
  // Never transitions to 'offline' — that's an aggregate concept the server computes when all tabs close.
  readonly selfState = signal<'online' | 'afk'>('online');

  private timerId: number | null = null;
  private started = false;
  private visibilityListener: (() => void) | null = null;
  private removeDomListeners: (() => void) | null = null;

  /** Called from AuthService once the user is authenticated. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.zone.runOutsideAngular(() => {
      const onActivity = (): void => this.reportActivity();
      // Capture + passive: catch bubbled events from anywhere; don't block scroll.
      for (const e of this.EVENTS) this.document.addEventListener(e, onActivity, { capture: true, passive: true });
      const onVisibility = (): void => {
        if (this.document.visibilityState === 'hidden') this.transitionTo('afk');
        else this.reportActivity();
      };
      this.document.addEventListener('visibilitychange', onVisibility);
      this.visibilityListener = onVisibility;
      this.removeDomListeners = () => {
        for (const e of this.EVENTS) this.document.removeEventListener(e, onActivity, { capture: true } as EventListenerOptions);
        this.document.removeEventListener('visibilitychange', onVisibility);
      };
    });
    // Start in active — emit a presence:active on connect reconnect cycles handled by socket service.
    this.reportActivity();
  }

  /** Called from AuthService.clearSession on logout. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.clearTimer();
    this.removeDomListeners?.();
    this.removeDomListeners = null;
    this.visibilityListener = null;
    this.selfState.set('online');  // reset for next session
  }

  private reportActivity(): void {
    // If we were idle, transition to active.
    this.transitionTo('online');
    // (Re)start the 60-s idle timer.
    this.clearTimer();
    this.timerId = this.document.defaultView!.setTimeout(() => {
      this.transitionTo('afk');
    }, this.AFK_MS) as unknown as number;
  }

  private transitionTo(state: 'online' | 'afk'): void {
    if (this.selfState() === state) return;
    // Run inside the zone so the computed signal for `selfState` re-evaluates templates.
    this.zone.run(() => this.selfState.set(state));
    this.socket.emit(state === 'online' ? 'presence:active' : 'presence:idle');
  }

  private clearTimer(): void {
    if (this.timerId !== null) {
      this.document.defaultView!.clearTimeout(this.timerId);
      this.timerId = null;
    }
  }
}
```

Notes:
- Listeners attached inside `NgZone.runOutsideAngular` — activity events fire on every mousemove, which would trigger change detection thousands of times per minute if not opted out. `transitionTo` re-enters the zone only on actual transitions (≤ 2 per minute).
- `reportActivity` always calls `transitionTo('online')` — the transition is a no-op if already online, so the only effect on repeated activity is the timer restart.
- Page Visibility integration: hidden → immediate `afk`; visible → `reportActivity` which flips to online AND starts a fresh 60-s timer.
- `stop()` is called from `AuthService.clearSession()` — same lifecycle hook as other `reset()` patterns.
- Self-state never goes to `offline` — the user is by definition not offline when their tab is rendering the UI.

### 3. SocketService — add typed `emit` overload for `ClientToServerEvents`

`frontend/src/app/core/socket/socket.service.ts` currently likely exposes a typed `on<E extends keyof ServerToClientEvents>(event: E, handler: …)`. Add a symmetric:

```ts
emit<E extends keyof ClientToServerEvents>(event: E): void;
// If ClientToServerEvents[E] is void, overload resolves to no second argument.
// (message:send still uses its own ad-hoc signature — untouched.)
```

Goals:
- `socket.emit('presence:active')` and `socket.emit('presence:idle')` type-check.
- Event-name typos caught at compile time.
- No regression on `message:send` — leave its existing ad-hoc emit signature intact (the `ClientToServerEvents` interface in shared deliberately omits `message:send` — see Round 7 orchestrator task 3 note).

If the existing `SocketService` emit helper is already generic over an `events` type, expand that type to `ClientToServerEvents` from `@shared`. If not, add a new `emit<E extends keyof ClientToServerEvents>(event: E)` overload.

### 4. Shared dot component — `frontend/src/app/shared/presence-dot.component.ts`

Tiny standalone component used across sidebar / DM header / room rail. Renders a coloured dot sized into the design system.

```ts
@Component({
  selector: 'app-presence-dot',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span
      class="presence-dot"
      [class.is-online]="state() === 'online'"
      [class.is-afk]="state() === 'afk'"
      [class.is-offline]="state() === 'offline'"
      [attr.aria-label]="ariaLabel()"
      [matTooltip]="tooltip()"
      matTooltipPosition="above"
    ></span>
  `,
  styleUrl: './presence-dot.component.scss',
  imports: [MatTooltipModule],
})
export class PresenceDotComponent {
  private readonly presence = inject(PresenceService);
  private readonly activity = inject(PresenceActivityService);
  private readonly auth = inject(AuthService);

  /** userId to render the dot for. If it's the caller, use selfState instead of the server map. */
  readonly userId = input.required<string>();

  readonly state = computed<PresenceState>(() => {
    const selfId = this.auth.currentUser()?.id;
    if (this.userId() === selfId) {
      // Self dot — never offline, map activity service's 'online'/'afk' 1:1.
      return this.activity.selfState();
    }
    return this.presence.stateFor(this.userId())();
  });

  readonly ariaLabel = computed(() => `User is ${this.state()}`);
  readonly tooltip = computed(() => {
    switch (this.state()) {
      case 'online': return 'Online';
      case 'afk': return 'Away from keyboard';
      case 'offline': return 'Offline';
    }
  });
}
```

SCSS (same folder, `presence-dot.component.scss`) — keep to utility-friendly CSS using the design-system tokens pattern (via `@use 'styles/tokens' as *` if you need map access for pseudo-class states):

```scss
@use '@angular/material' as mat;
@use 'sass:map';
@use 'styles/tokens' as *;

.presence-dot {
  display: inline-block;
  width: 0.625rem;    // 10px — matches sidebar row icon sizing
  height: 0.625rem;
  border-radius: 50%;
  flex-shrink: 0;
  border: 0.0625rem solid var(--mat-sys-surface);   // contrast ring against avatar / row bg — only place `--mat-sys-*` is allowed: inside .scss via CSS var
  box-sizing: border-box;

  &.is-online {
    background-color: map.get($ds-colors, 'tertiary');    // green-ish accent per design system
  }
  &.is-afk {
    background-color: map.get($ds-colors, 'secondary');   // amber / muted warm hue
  }
  &.is-offline {
    background-color: map.get($ds-colors, 'surface-variant');
  }
}
```

Notes:
- The `--mat-sys-surface` CSS variable reference inside `.scss` is the only acceptable use per the design system rule (the forbidden pattern is `var(--mat-sys-*)` in **templates/inline styles**; SCSS + CSS vars for token access is fine — follow whatever pattern `frontend/docs/DESIGN_SYSTEM.md` actually prescribes for pseudo-class / dynamic-contrast use cases).
- If the design system's `$ds-colors` token names don't match `tertiary/secondary/surface-variant`, use the closest semantic tokens (e.g. whatever the existing friend-avatar ring uses for "active"). Grep the existing SCSS for `map.get($ds-colors` to find the canonical names.
- No hex. No `px`. No forbidden tokens in the template — the template only uses utility-class-friendly bindings.

### 5. Integrate `PresenceDotComponent` at four render sites

#### 5a. Friend rows — `frontend/src/app/chat/rooms-sidebar.component.html`
Each friend row already renders an avatar + username + (Round 6) Message icon + overflow menu. Add the presence dot to the LEFT of the avatar. Do NOT remove any existing content.

```html
<!-- inside @for (friend of friends; track friend.userId) -->
<app-presence-dot [userId]="friend.userId" />
<!-- existing avatar + username + message icon + overflow menu -->
```

#### 5b. DM sidebar rows — same file
Each DM row renders avatar + `dmPeer.username` + overflow. Add the dot to the LEFT of the avatar, keyed on `room.dmPeer!.userId`.

```html
<!-- inside @for (room of dmRooms; track room.id) -->
<app-presence-dot [userId]="room.dmPeer!.userId" />
<!-- existing avatar + dm peer username + overflow menu -->
```

Coexistence with Round 6 ban-lock icon: the lock renders to the LEFT of the message input (on the row) — presence dot is to the LEFT of the avatar. They do not overlap. Verify by running `docker compose up` and opening a banned-DM row; both icons render, no layout jank.

#### 5c. DM header — `frontend/src/app/chat/room-view.component.html`
For `room.type === 'dm'` the header renders `@{{ room.dmPeer.username }}`. Add the dot immediately to the LEFT of `@username`:

```html
@if (room().type === 'dm') {
  <div class="flex items-center gap-2">
    <app-presence-dot [userId]="room().dmPeer!.userId" />
    <span class="text-lg">@{{ room().dmPeer!.username }}</span>
    <!-- existing overflow menu -->
  </div>
}
```

Use the project's spacing utilities (`gap-2` is example — use whatever the existing design system header pattern uses).

#### 5d. Room member rail — `frontend/src/app/chat/room-rail.component.html`
The member rail renders `@for (member of members; track member.userId) { … username … role chip … }`. Add the dot to the LEFT of the username on every row. Self row (caller) gets the dot too — the `PresenceDotComponent`'s internal logic handles self via `PresenceActivityService.selfState`.

```html
<li *ngFor="let member of members(); trackBy: trackByUserId">
  <app-presence-dot [userId]="member.userId" />
  <span>{{ member.username }}</span>
  <!-- role chip, etc. -->
</li>
```

### 6. Wire lifecycle into `AuthService`

`frontend/src/app/core/auth/auth.service.ts` already eagerly constructs `DmsService` / `UserBansService` / `FriendsService` and calls their `fetchInitial` / `reset` hooks on login / session-restore / logout. Follow the same pattern:

- Inject `PresenceService` (for the eager socket subscription) and `PresenceActivityService` (for the activity tracker start / stop).
- On login success + session-restore success: call `presenceActivityService.start()`. The `PresenceService` doesn't need a `fetchInitial` — the server sends `presence:snapshot` automatically on socket connect.
- On `clearSession()` (logout): call `presenceActivityService.stop()` and `presenceService.reset()`.

Parity with Round 6's pattern: the injections are needed purely for eager construction + lifecycle. Store the references on `this` so TS unused-locals don't flag them.

### 7. Do NOT add an HTTP client
Presence is a socket-only surface. No new HTTP service. Do not create `frontend/src/app/core/presence/presence.http.ts` or similar.

### 8. Design-system compliance spot-check
Before writing the summary, grep the Round 7 diff for forbidden tokens:
- Zero new `var(--mat-sys-*)` in `.html` / `.ts` templates (CSS var references inside `.scss` files are fine if used for pseudo-class / dynamic states per the existing pattern — follow whatever `frontend/docs/DESIGN_SYSTEM.md` prescribes; the SCSS snippet in task 4 is indicative).
- Zero hex colors, `rgb()`, or named colors in the new files.
- Zero `px` literals. All lengths in `rem`.

If any forbidden token lands, fix before writing the summary — don't paper over it.

### 9. Verification gate before summary
- `pnpm lint` in `frontend/` — zero warnings, zero new rule violations.
- `pnpm build` in `frontend/` — clean.
- TypeScript type-check clean — `socket.emit('presence:active')` resolves via `ClientToServerEvents`; `socket.on('presence:update', …)` resolves via `ServerToClientEvents` with the `PresenceUpdatePayload` shape.
- Per frontend-developer dispatch mode rules: **do not** use Playwright MCP in Implement mode. Leave exercise steps for the tester.

## Wrap-up
Write `plans/round-7/frontend_work_summary.md` with:
- **Built** — one bullet per feature (activity service, presence service, dot component, four render-site integrations, AuthService lifecycle wiring).
- **How to exercise this** — explicit tester-facing steps per feature. Tester drives from this, so be concrete:
  - "Two browser sessions, alice and bob, friends. Both signed in. Alice's sidebar friend row for bob shows ● (online) on a green dot. Bob alt-tabs away for 60 s — alice's row flips to ◐ (afk, amber). Bob returns and moves the mouse — back to ●."
  - "Alice closes all bob's tabs → alice sees ○ (offline) within 2 s."
  - "Alice opens bob's DM → the DM header renders ● to the left of `@bob`. The dot mirrors the sidebar state in real time."
  - "Room member rail: enter a shared channel, alice sees a dot next to every member including herself. Her own dot mirrors her local activity (never offline)."
  - "Multi-tab: bob opens two tabs, leaves tab1 active. Alice sees bob as ●. Bob minimises tab1 (hidden) → still ● on alice's side because tab2 is active. Bob minimises tab2 too → ◐ within 2 s."
- **Deviations** — design-system token-name adjustments (likely — the SCSS in task 4 named `tertiary/secondary/surface-variant` — document whatever the project actually uses); any zone-integration surprises.
- **Deferred** — grace-period flash smoothing on disconnect (BE-side, not a FE concern per se); own-dot colour-matching polish; tooltip i18n.
- **Next round needs to know**
  - For Round 8 (attachments): the DM composer's `isFrozen` gate from Round 6 does not interact with presence. No coupling.
  - For Round 9 (pagination): no coupling.
  - For Round 11 (moderation): when a user is removed from a room, the removed user's dot should naturally drop from the member rail (the rail re-renders from `chatContext.currentRoom().members` which the server already updates). No presence-specific invalidation.
  - For Round 12 (unread): no coupling.
- **Config improvements** — generic `ConfirmDialogComponent` (still deferred from Round 6); APP_INITIALIZER migration (still deferred from Round 6 bug 1); whether `selfState` should be a tri-state (`online/afk/offline`) with `offline` only on explicit logout — current "never offline" design is pragmatic but masks edge cases like socket-disconnect-while-tab-still-open; whether the activity service should debounce `transitionTo('online')` calls when activity is already online (currently a no-op inside the method, but we could bail earlier to skip even the timer reset on every mousemove — current design resets the timer on every event, which is correct for the 60-s window semantics, but means `setTimeout` is called extremely frequently under heavy mouse movement — low cost in practice).
