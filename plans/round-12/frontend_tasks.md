# Round 12 — Frontend Tasks

## Goal
Two parallel FE features landing in one round:
1. **Unread badges** — each sidebar room/DM row shows a `mat-badge` with the count; badge clears on room-open and on `room:read` socket events (multi-tab sync); live `message:new` arrivals increment the local count for non-active rooms.
2. **Public room catalog** — a new `/public-rooms` route with search, pagination, and Open/Join actions per entry.

Both are additive — no existing layout reflows.

## Dependencies
- `/shared/api-contract.md` — the Round-12 orchestrator's new `## Unread Endpoints` + `## Public Room Catalog` sections, the `room:read` socket block, and the summary-table rows for `POST /api/rooms/:id/read` + `GET /api/rooms/catalog`.
- `/shared/types/unread.ts` — `UnreadCount`, `MarkRoomReadResponse`, `RoomReadPayload`.
- `/shared/types/catalog.ts` — `PublicRoomCatalogEntry`, `PublicCatalogResponse`.
- `/shared/types/socket.ts` — `ServerToClientEvents['room:read']` newly typed.
- **Do not modify `/shared/`.** If a contract / type change is needed, report to the orchestrator.
- `frontend/CLAUDE.md` — folder layout, signals-first state, `inject()` in factories, `ReactiveFormsModule` only.
- `frontend/docs/DESIGN_SYSTEM.md` + `.claude/skills/design-system/SKILL.md` — utility classes only; no `--mat-sys-*` in templates; rem only, no px; `mat-*` components preferred.
- `frontend/src/app/core/socket/socket.service.ts` — the typed `on<E>(event)` / `emitWithAck` helpers; add the new `room:read` stream here via `on('room:read')`.
- `frontend/src/app/chat/rooms-sidebar.component.ts` + `.html` — existing sidebar; badges go next to room/DM names.
- `frontend/src/app/chat/room-view.component.ts` — the component mounted at `/chat/:roomId`; this is where the mark-read trigger fires on enter + on live `message:new`.
- `frontend/src/app/chat/rooms.service.ts` — existing cached `roomsSignal`; unread uses its own service (new).
- `frontend/src/app/app.routes.ts` — add the new `/public-rooms` child route under the shell.
- `frontend/src/app/shell/shell.component.html` — top nav: repoint the existing placeholder "Public Rooms" link to `/public-rooms`.

## Tasks

### 1. Create `UnreadService` — `frontend/src/app/core/unread/unread.service.ts`

New folder `core/unread/`. This is a root-scoped singleton (same pattern as `core/friends/friends.service.ts`).

```ts
@Injectable({ providedIn: 'root' })
export class UnreadService {
  private readonly http = inject(HttpClient);
  private readonly socketService = inject(SocketService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly baseUrl = environment.apiUrl;

  /** Count per room id. Absent key = 0. */
  private readonly counts = signal<ReadonlyMap<string, number>>(new Map());

  /** The currently-viewed room id (set by RoomViewComponent). `null` when no room is open. */
  private readonly activeRoomId = signal<string | null>(null);

  /** Debounce guard — last markRead timestamp per room (ms epoch). Rate-limits hot paths. */
  private readonly lastMarkReadAt = new Map<string, number>();
  private static readonly MARK_READ_DEBOUNCE_MS = 500;

  /** Public read-only signal for template bindings. */
  readonly unreadByRoomId = this.counts.asReadonly();

  countFor(roomId: string): Signal<number> {
    return computed(() => this.counts().get(roomId) ?? 0);
  }

  /** Called once from APP_INITIALIZER (or AuthService's post-login hook). */
  initialize(): Observable<UnreadCount[]> {
    return this.http.get<UnreadCount[]>(`${this.baseUrl}/unread`).pipe(
      tap((list) => {
        const next = new Map<string, number>();
        for (const r of list) {
          if (r.unreadCount > 0) next.set(r.roomId, r.unreadCount);
        }
        this.counts.set(next);
      }),
    );
  }

  /** Called by RoomViewComponent on route enter. */
  setActiveRoom(roomId: string | null): void {
    this.activeRoomId.set(roomId);
    if (roomId) this.markRoomRead(roomId);
  }

  /** Called by RoomViewComponent when a `message:new` arrives for the active room. */
  onLiveMessageInActiveRoom(roomId: string): void {
    this.markRoomRead(roomId);
  }

  private markRoomRead(roomId: string): void {
    const now = Date.now();
    const last = this.lastMarkReadAt.get(roomId) ?? 0;
    if (now - last < UnreadService.MARK_READ_DEBOUNCE_MS) return;
    this.lastMarkReadAt.set(roomId, now);

    // Optimistic clear — no rollback needed; a failed POST just means the
    // server cursor stays where it was, and the next `message:new` repaints
    // the badge. Multi-tab sync piggybacks on the `room:read` echo.
    this.clearCount(roomId);

    this.http
      .post<MarkRoomReadResponse>(`${this.baseUrl}/rooms/${roomId}/read`, {})
      .subscribe({
        error: () => {
          // Silent — future `message:new` will re-accrue. No snackbar: this is
          // fire-and-forget UX.
        },
      });
  }

  private clearCount(roomId: string): void {
    this.counts.update((map) => {
      if (!map.has(roomId)) return map;
      const next = new Map(map);
      next.delete(roomId);
      return next;
    });
  }

  private increment(roomId: string): void {
    this.counts.update((map) => {
      const next = new Map(map);
      next.set(roomId, (map.get(roomId) ?? 0) + 1);
      return next;
    });
  }

  constructor() {
    // Live increment on `message:new` for rooms that are NOT currently open.
    this.socketService
      .on('message:new')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((msg) => {
        // Don't increment on the caller's own messages — they're authored,
        // not "received". The BE already excludes them from the count but the
        // wire event echoes back for the user's other tabs.
        // TODO: compare msg.userId against authService.currentUser()?.id —
        // inject AuthService, check current user id. See task 2.
        if (msg.roomId === this.activeRoomId()) return;
        this.increment(msg.roomId);
      });

    // Multi-tab sync — when ANY of the user's tabs marks a room read, all
    // tabs receive `room:read` and clear the badge.
    this.socketService
      .on('room:read')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((payload) => {
        this.clearCount(payload.roomId);
      });
  }
}
```

Sharp edges to handle:
- **Own-message suppression**: inject `AuthService` and skip increment when `msg.userId === authService.currentUser()?.id`. The message-sender socket doesn't receive its own `message:new` broadcast (per the contract), but OTHER tabs of the same user DO — we must not bump the badge in the sender's other tabs.
- **Initialize timing**: call `unreadService.initialize()` from the same place that `AuthService` hydrates the current user after `refresh()` — look at how `FriendsService.loadFriends()` is invoked today (likely from `APP_INITIALIZER` or an `app.ts` hook). Mirror that pattern.
- **Room-swap**: `setActiveRoom(roomId)` is called on router enter. On route leave (or app close), call `setActiveRoom(null)` — the `RoomViewComponent.ngOnDestroy` is the cleanest hook.

### 2. Wire `UnreadService.initialize()` into the app startup

Follow the pattern already used for `FriendsService` / `InvitationsService` — check `frontend/src/app/app.config.ts` and/or `frontend/src/app/app.ts` for a post-auth init block, and add:

```ts
// Inside the existing post-auth init sequence (wherever FriendsService.loadFriends is called)
unreadService.initialize().subscribe();
```

If no such hook exists, fall back to calling it from `SocketService`'s post-connect hook, or from `ShellComponent.ngOnInit`. Pick whichever matches the project's existing convention; document the choice in the summary.

### 3. Attach badges to sidebar rows — `rooms-sidebar.component.ts` / `.html`

Inject `UnreadService` in the component and expose a lookup:

```ts
protected readonly unreadService = inject(UnreadService);

// Optional helper if template legibility suffers — otherwise inline
unreadCount(roomId: string): number {
  return this.unreadService.unreadByRoomId().get(roomId) ?? 0;
}
```

Template changes — for each of the three room lists (Public Rooms, Private Rooms, DMs):

```html
<a
  mat-list-item
  class="room-item"
  [routerLink]="['/chat', room.id]"
  routerLinkActive="room-item--active"
  [matBadge]="unreadCount(room.id) || null"
  matBadgeColor="primary"
  matBadgeSize="small"
  matBadgeOverlap="false"
  matBadgePosition="before"
>
  ...
</a>
```

Key points:
- `[matBadge]="unreadCount(room.id) || null"` — `null` hides the badge when count is 0. Do NOT pass `0` (it renders a "0" dot).
- `matBadgeOverlap="false"` — the badge sits INLINE next to the name, not overlapping the list-item icon. This matches the wireframe `:: general        (3)` layout.
- `matBadgePosition="before"` — badge appears to the LEFT of the bound element. The wireframe-adjacent UX is "count on the right, after member count" OR "count next to name"; either works — pick one and apply it consistently.
- Clamp to `99+` via a small computed helper OR leave raw for MVP (room unread above 99 is uncommon at hackathon scale). Orchestrator D5 says the WIRE is not clamped; clamping is a pure template detail.

Apply the same `[matBadge]` pattern to the DM list (`<li class="dm-item">` / its `<a>` link).

### 4. Call `unreadService.setActiveRoom(roomId)` from `RoomViewComponent`

Edit `frontend/src/app/chat/room-view.component.ts` (or wherever `/chat/:roomId` is handled):

```ts
private readonly unreadService = inject(UnreadService);

ngOnInit(): void {
  // existing init …
  this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((p) => {
    const roomId = p.get('roomId');
    this.unreadService.setActiveRoom(roomId);
  });

  // existing message:new subscription — augment it:
  this.messagesService
    .newMessages$(this.roomId)
    .pipe(takeUntilDestroyed(this.destroyRef))
    .subscribe((msg) => {
      // existing append to list …
      this.unreadService.onLiveMessageInActiveRoom(msg.roomId);
    });
}

ngOnDestroy(): void {
  this.unreadService.setActiveRoom(null);
}
```

Adjust to the actual `RoomViewComponent` structure — the exact route-param hook and message-subscription patterns may already be in place via `ChatContextService` or a similar helper. Follow the existing wiring; do NOT introduce a new one.

**Sharp edge**: if `RoomViewComponent` reads the room id once from a route snapshot rather than a param stream, you may need to also react when the user navigates from `/chat/<A>` to `/chat/<B>` without the component being destroyed. Check `onChange` behavior — if the component reuses across router swaps, re-wire `setActiveRoom` in `ngOnChanges` too.

### 5. Create `CatalogService` — `frontend/src/app/chat/catalog.service.ts`

Sits next to `rooms.service.ts` since it's rooms-domain.

```ts
@Injectable({ providedIn: 'root' })
export class CatalogService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/rooms/catalog`;

  list(options: { q?: string; cursor?: string; limit?: number } = {}): Observable<PublicCatalogResponse> {
    let params = new HttpParams();
    if (options.q && options.q.length > 0) params = params.set('q', options.q);
    if (options.cursor) params = params.set('cursor', options.cursor);
    if (options.limit != null) params = params.set('limit', String(options.limit));
    return this.http.get<PublicCatalogResponse>(this.baseUrl, { params });
  }
}
```

No local caching — the catalog is a live search page. The page component holds its own accumulated rows.

### 6. Create `PublicCatalogComponent` — `frontend/src/app/chat/public-catalog.component.{ts,html,scss}`

A standalone component, `ChangeDetectionStrategy.OnPush`, mounted at `/public-rooms` under the shell.

**State (signals):**
- `rooms: WritableSignal<PublicRoomCatalogEntry[]>` — accumulated rows (cleared on new search).
- `loading: WritableSignal<boolean>` — initial fetch only.
- `loadingMore: WritableSignal<boolean>` — "Load more" button / auto-trigger.
- `hasMore: WritableSignal<boolean>`.
- `nextCursor: WritableSignal<string | null>`.
- `loadError: WritableSignal<boolean>`.
- `joiningIds: WritableSignal<ReadonlySet<string>>` — per-row Join button spinner.

**Inputs:**
- `searchControl = new FormControl<string>('', { nonNullable: true })` with `valueChanges.pipe(debounceTime(300), distinctUntilChanged())` → triggers a fresh fetch (reset list, clear cursor).

**Template structure:**

```html
<section class="public-catalog p-4 gap-4">
  <header class="public-catalog__header gap-4">
    <h1 class="text-headline-small m-0">Public rooms</h1>
    <mat-form-field appearance="outline" class="public-catalog__search" subscriptSizing="dynamic">
      <mat-icon matPrefix>search</mat-icon>
      <mat-label>Search rooms</mat-label>
      <input matInput type="text" [formControl]="searchControl" autocomplete="off" />
    </mat-form-field>
  </header>

  @if (loading()) {
    <div class="public-catalog__loading gap-2">
      <mat-progress-spinner diameter="24" mode="indeterminate" />
      <span class="text-body-medium text-on-surface-variant">Loading rooms…</span>
    </div>
  } @else if (loadError()) {
    <div class="public-catalog__error bg-error-container text-on-error-container p-4 gap-2">
      <mat-icon>error_outline</mat-icon>
      <span class="text-body-medium">Could not load rooms.</span>
      <button mat-stroked-button (click)="retry()">Retry</button>
    </div>
  } @else if (rooms().length === 0) {
    <div class="public-catalog__empty p-6">
      <mat-icon class="text-on-surface-variant">search_off</mat-icon>
      <p class="text-body-medium text-on-surface-variant m-0">
        @if (searchControl.value) {
          No rooms match "{{ searchControl.value }}".
        } @else {
          No public rooms yet. Be the first to create one.
        }
      </p>
    </div>
  } @else {
    <ul class="public-catalog__list gap-2">
      @for (room of rooms(); track room.id) {
        <li class="catalog-card bg-surface-container p-4 gap-3">
          <div class="catalog-card__body">
            <header class="catalog-card__head gap-2">
              <mat-icon class="catalog-card__icon text-on-surface-variant">tag</mat-icon>
              <h2 class="catalog-card__name text-title-small m-0">{{ room.name }}</h2>
              <span class="catalog-card__count text-label-small text-on-surface-variant ml-auto">
                {{ room.memberCount }} member{{ room.memberCount === 1 ? '' : 's' }}
              </span>
            </header>
            @if (room.description) {
              <p class="catalog-card__desc text-body-medium text-on-surface-variant m-0">
                {{ room.description }}
              </p>
            }
          </div>
          <footer class="catalog-card__actions gap-2">
            @if (room.isMember) {
              <a mat-stroked-button [routerLink]="['/chat', room.id]">Open</a>
            } @else {
              <button
                mat-flat-button
                color="primary"
                type="button"
                [disabled]="joiningIds().has(room.id)"
                (click)="join(room)"
              >
                Join
              </button>
            }
          </footer>
        </li>
      }
    </ul>

    @if (hasMore()) {
      <button
        mat-stroked-button
        type="button"
        class="public-catalog__load-more"
        [disabled]="loadingMore()"
        (click)="loadMore()"
      >
        @if (loadingMore()) {
          <mat-progress-spinner diameter="18" mode="indeterminate" />
          Loading…
        } @else {
          Load more
        }
      </button>
    }
  }
</section>
```

**Component methods:**

```ts
ngOnInit(): void {
  this.loadInitial();
  this.searchControl.valueChanges
    .pipe(debounceTime(300), distinctUntilChanged(), takeUntilDestroyed(this.destroyRef))
    .subscribe(() => this.loadInitial());
}

private loadInitial(): void {
  this.loading.set(true);
  this.loadError.set(false);
  this.catalog.list({ q: this.searchControl.value, limit: 20 }).subscribe({
    next: (res) => {
      this.rooms.set(res.rooms);
      this.hasMore.set(res.hasMore);
      this.nextCursor.set(res.nextCursor);
      this.loading.set(false);
    },
    error: () => {
      this.loading.set(false);
      this.loadError.set(true);
    },
  });
}

loadMore(): void {
  const cursor = this.nextCursor();
  if (!cursor || this.loadingMore()) return;
  this.loadingMore.set(true);
  this.catalog.list({ q: this.searchControl.value, cursor, limit: 20 }).subscribe({
    next: (res) => {
      this.rooms.update((list) => [...list, ...res.rooms]);
      this.hasMore.set(res.hasMore);
      this.nextCursor.set(res.nextCursor);
      this.loadingMore.set(false);
    },
    error: () => {
      this.loadingMore.set(false);
      // Leave existing rows visible; user can retry via "Load more"
    },
  });
}

join(room: PublicRoomCatalogEntry): void {
  this.markJoining(room.id, true);
  this.roomsService.join(room.id).subscribe({
    next: (detail) => {
      this.markJoining(room.id, false);
      // Mark the row as member so the button flips to "Open"
      this.rooms.update((list) =>
        list.map((r) => (r.id === room.id ? { ...r, isMember: true, memberCount: detail.memberCount } : r)),
      );
      // Optimistic sidebar insert — RoomsService doesn't currently upsert on
      // join HTTP success (only on `room:updated` socket). Push it in:
      this.roomsService.upsertRoom(detail);
      this.router.navigate(['/chat', room.id]);
    },
    error: (err: HttpErrorResponse) => {
      this.markJoining(room.id, false);
      const msg = err.error?.error ?? 'Failed to join room.';
      this.snackBar.open(msg, 'Dismiss', { duration: 5000 });
    },
  });
}
```

Keep the component self-contained — no shared dialog, no cross-cutting state.

### 7. Register the `/public-rooms` route

Edit `frontend/src/app/app.routes.ts` — add under the existing shell-wrapped section, alongside `/chat` and `/sessions`:

```ts
{
  path: 'public-rooms',
  loadComponent: () =>
    import('./chat/public-catalog.component').then((m) => m.PublicCatalogComponent),
},
```

### 8. Repoint the shell top-nav "Public Rooms" link

Edit `frontend/src/app/shell/shell.component.html` — find the existing `<a mat-button routerLink="/chat">` with the "Public Rooms" label and change it to `routerLink="/public-rooms"`. This is today's placeholder (points at `/chat`) — Round 12 makes it the real destination.

Keep "Private Rooms" and "Contacts" as placeholders (not in Round 12 scope).

### 9. SCSS for `public-catalog.component.scss`

Keep it minimal — most layout comes from utility classes. Add only layout rules that can't be expressed via utilities:

```scss
:host {
  display: block;
  max-width: 60rem;
  margin: 0 auto;
}

.public-catalog__search {
  flex: 1;
  max-width: 32rem;
}

.public-catalog__header {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
}

.public-catalog__list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
}

.catalog-card {
  display: flex;
  align-items: center;
  border-radius: 0.75rem;
}

.catalog-card__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.catalog-card__head {
  display: flex;
  align-items: center;
}

.catalog-card__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.catalog-card__desc {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.public-catalog__load-more {
  align-self: center;
}
```

No color literals, no hex, no px. All spacing in rem. Colors come from the utility classes on the template.

### 10. Verification gate

- `pnpm build` in `frontend/` — clean (0 errors).
- `pnpm typecheck` (if a dedicated script exists) — clean.
- Design-system grep on the diff: `grep -E '(--mat-sys-|#[0-9a-f]{3,6}|\\d+px)' <changed files>` → zero matches.
- Do NOT run `ng serve`; do NOT use Playwright MCP.

### 11. Do not introduce new dependencies

No new `npm` packages. Everything works with Angular Material M3, signals, RxJS, and the existing shared types.

## How to exercise this (Tester notes — fill concrete steps in the summary)

Feature 1: **Sidebar unread badges**
- Sign in as user A in one browser. Keep the sidebar visible.
- Sign in as user B in another browser (different session). Send 3 messages to a channel A is a member of but NOT currently viewing (e.g. `#random` while A is on `#general`).
- A's sidebar should show a count badge of `3` on `#random`. Click `#random` — badge clears immediately (optimistic) and stays cleared.
- Multi-tab: open a SECOND tab for user A. Open `#random` in tab 1; in tab 2's sidebar the badge should also clear (via `room:read` socket echo).
- Own-message suppression: as user A in tab 1, send a message to `#general`. Tab 2's sidebar should NOT bump `#general`'s badge (author equals current user).

Feature 2: **Public Room Catalog**
- Click "Public Rooms" in the top nav — the page renders at `/public-rooms`.
- Type a substring in the search box; the list filters after ~300 ms debounce.
- Scroll / click "Load more" when `hasMore` is true; new rows append below without losing the existing ones.
- Click "Join" on a row the user is not yet a member of — button shows a spinner briefly; row flips to an "Open" button; the new room appears in the sidebar; the app navigates to `/chat/<id>`.
- Clear the search box — list returns to the default newest-first view.
- Sign out + sign back in — unread counts hydrate correctly on return (they're reloaded via `UnreadService.initialize()`).

## Wrap-up
Write `plans/round-12/frontend_work_summary.md` with:

- **Built** — `UnreadService` (+ wiring into startup init), badge integration in `rooms-sidebar.component`, `setActiveRoom` + `onLiveMessageInActiveRoom` hooks in `RoomViewComponent`, `CatalogService`, `PublicCatalogComponent`, `/public-rooms` route, top-nav repoint. Note whether `RoomsService.upsertRoom` was reused for the post-join sidebar update (see task 6) vs whether an explicit `refresh()` landed.
- **How to exercise this** — per feature: route, user steps, expected visible state. Be explicit; the tester drives from this.
- **Deviations** — likely pressure points:
  - (a) How own-message suppression was implemented (injecting `AuthService` into `UnreadService` vs a different hook).
  - (b) Where `UnreadService.initialize()` got wired (APP_INITIALIZER vs app.ts vs ShellComponent).
  - (c) Whether `setActiveRoom(null)` on route leave fires reliably (RoomViewComponent lifecycle vs ChatLayoutComponent router-outlet activation — pick whichever is cleanest).
  - (d) Mark-read debounce window — 500 ms was the task-file default; tune if UX feels laggy.
  - (e) Badge placement (`matBadgePosition="before"` vs default `after`) — orchestrator didn't mandate; pick what reads best.
- **Deferred** — live catalog updates via a socket push (orchestrator D11 — pull-based is accepted); virtual scroll on the catalog (not needed at hackathon row counts); "NN+" badge clamping in the template; a distinct empty state for "you belong to 0 rooms" on the sidebar (existing copy is fine); accessibility audit (focus management on "Load more", screen-reader announcements for unread bumps).
- **Next round needs to know** — `UnreadService.counts` is a `Map<string, number>` keyed by `roomId`; future jump-to-first-unread UI can derive the "first unread cursor" by asking the BE (requires Round-9 deferred `?after=`); the `room:read` socket event is consumed by `UnreadService` alone — don't overload it with non-unread semantics.
- **Config improvements** — promote `MARK_READ_DEBOUNCE_MS` + catalog `PAGE_LIMIT` to a `chatUx` const map (parallel to Round 9's `LOAD_MORE_TRIGGER_REM` suggestion); `IntersectionObserver` auto-trigger for "Load more" on the catalog; `TrackByFunction` for the catalog list (ids only); `NN+` clamp as a shared pipe so every badge in the app uses the same cap.
