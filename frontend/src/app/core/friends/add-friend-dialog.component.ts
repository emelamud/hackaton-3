import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ReactiveFormsModule, FormControl, Validators } from '@angular/forms';
import {
  debounceTime,
  distinctUntilChanged,
  of,
  switchMap,
  catchError,
  Observable,
} from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { UsersService } from '../users/users.service';
import { FriendsService } from './friends.service';
import { UserBansService } from '../user-bans/user-bans.service';
import {
  BlockUserDialogComponent,
  type BlockUserDialogData,
} from '../user-bans/block-user-dialog.component';
import { MatDialog } from '@angular/material/dialog';
import type {
  FriendRequest,
  UserSearchRelationship,
  UserSearchResult,
} from '@shared';

/** Local row state — tracks the relationship + whether the message composer is expanded. */
interface SearchRow {
  readonly id: string;
  readonly username: string;
  readonly relationship: UserSearchRelationship;
  readonly composerOpen: boolean;
}

@Component({
  selector: 'app-add-friend-dialog',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatChipsModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './add-friend-dialog.component.html',
  styleUrl: './add-friend-dialog.component.scss',
})
export class AddFriendDialogComponent {
  private readonly usersService = inject(UsersService);
  private readonly friendsService = inject(FriendsService);
  private readonly userBansService = inject(UserBansService);
  private readonly dialogRef = inject(MatDialogRef<AddFriendDialogComponent, null>);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);
  private readonly destroyRef = inject(DestroyRef);

  readonly searchControl = new FormControl<string>('', {
    nonNullable: true,
    validators: [Validators.minLength(2), Validators.maxLength(64)],
  });

  readonly messageControl = new FormControl<string>('', {
    nonNullable: true,
    validators: [Validators.maxLength(500)],
  });

  /** Reflects UI state of each currently-rendered row. Keyed by userId. */
  readonly results = signal<SearchRow[]>([]);
  readonly searching = signal(false);
  /** userId of the row whose message composer is currently expanded (if any). */
  readonly activeComposer = signal<string | null>(null);
  readonly submittingIds = signal<ReadonlySet<string>>(new Set());
  readonly lastQueryTooShort = signal(false);

  /** Expose friends service signals to the template for live relationship reconciliation. */
  readonly friendIds = computed(
    () => new Set(this.friendsService.friends().map((f) => f.userId)),
  );
  readonly outgoingByToUserId = computed(() => {
    const map = new Map<string, FriendRequest>();
    for (const r of this.friendsService.outgoingRequests()) {
      map.set(r.toUserId, r);
    }
    return map;
  });
  readonly incomingByFromUserId = computed(() => {
    const map = new Map<string, FriendRequest>();
    for (const r of this.friendsService.incomingRequests()) {
      map.set(r.fromUserId, r);
    }
    return map;
  });

  constructor() {
    this.searchControl.valueChanges
      .pipe(
        debounceTime(250),
        distinctUntilChanged(),
        switchMap((raw) => this.runSearch(raw)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((rows) => {
        this.searching.set(false);
        this.results.set(rows);
      });
  }

  private runSearch(raw: string): Observable<SearchRow[]> {
    const query = (raw ?? '').trim();
    if (query.length < 2) {
      this.searching.set(false);
      this.lastQueryTooShort.set(query.length > 0 && query.length < 2);
      this.results.set([]);
      return of<SearchRow[]>([]);
    }
    this.lastQueryTooShort.set(false);
    this.searching.set(true);
    return this.usersService.search(query).pipe(
      catchError(() => {
        this.searching.set(false);
        this.snackBar.open('Search failed. Please try again.', 'Dismiss', { duration: 5000 });
        return of<UserSearchResult[]>([]);
      }),
      // Keep each row's composerOpen state if it's the same user as before.
      switchMap((results) => {
        const prevOpen = this.activeComposer();
        const rows: SearchRow[] = results.map((r) => ({
          id: r.id,
          username: r.username,
          relationship: r.relationship,
          composerOpen: prevOpen === r.id && r.relationship === 'none',
        }));
        return of(rows);
      }),
    );
  }

  /** Resolve a result row's CURRENT relationship — overlaying live friend/request state. */
  effectiveRelationship(row: SearchRow): UserSearchRelationship {
    if (this.friendIds().has(row.id)) return 'friend';
    if (this.outgoingByToUserId().has(row.id)) return 'outgoing_pending';
    if (this.incomingByFromUserId().has(row.id)) return 'incoming_pending';
    return row.relationship;
  }

  /**
   * Ban-aware overlay. The server's `relationship` field does NOT surface ban
   * state — we derive it locally from `UserBansService`. Templates check this
   * FIRST, before `effectiveRelationship`, to short-circuit the friend-action
   * buttons when the caller has blocked the target.
   */
  isBanned(row: SearchRow): boolean {
    return this.userBansService.isBanned(row.id);
  }

  /**
   * Unblock shortcut wired directly from the Add Friend dialog row. Opens no
   * confirmation dialog — the user already intends to interact with this
   * person, so requiring a second confirm to UN-block would be friction.
   * The row flips back to its server-reported `relationship` once the
   * `incomingBans`/`blocks` signal updates.
   */
  unblock(row: SearchRow): void {
    if (this.isSubmitting(row.id)) return;
    this.markSubmitting(row.id, true);
    this.userBansService.unblock(row.id).subscribe({
      next: () => this.markSubmitting(row.id, false),
      error: (err: HttpErrorResponse) => {
        this.markSubmitting(row.id, false);
        const msg = err.error?.error ?? 'Failed to unblock. Please try again.';
        this.snackBar.open(msg, 'Dismiss', { duration: 5000 });
      },
    });
  }

  /**
   * Block shortcut — opens the confirmation dialog. Matches the Round 6 UX
   * on the friend/DM rows so users hit the same confirm regardless of which
   * surface initiated the block.
   */
  block(row: SearchRow): void {
    if (this.isSubmitting(row.id)) return;
    const data: BlockUserDialogData = { username: row.username };
    this.dialog
      .open<BlockUserDialogComponent, BlockUserDialogData, boolean>(BlockUserDialogComponent, {
        width: '28rem',
        data,
        autoFocus: 'first-tabbable',
        restoreFocus: true,
      })
      .afterClosed()
      .subscribe((confirmed) => {
        if (!confirmed) return;
        this.markSubmitting(row.id, true);
        this.userBansService.block(row.id).subscribe({
          next: () => this.markSubmitting(row.id, false),
          error: (err: HttpErrorResponse) => {
            this.markSubmitting(row.id, false);
            const msg = err.error?.error ?? 'Failed to block user. Please try again.';
            this.snackBar.open(msg, 'Dismiss', { duration: 5000 });
          },
        });
      });
  }

  outgoingRequestId(row: SearchRow): string | null {
    return this.outgoingByToUserId().get(row.id)?.id ?? null;
  }

  incomingRequestId(row: SearchRow): string | null {
    return this.incomingByFromUserId().get(row.id)?.id ?? null;
  }

  close(): void {
    this.dialogRef.close(null);
  }

  openComposer(row: SearchRow): void {
    this.activeComposer.set(row.id);
    this.messageControl.setValue('');
    this.results.update((list) =>
      list.map((r) => (r.id === row.id ? { ...r, composerOpen: true } : { ...r, composerOpen: false })),
    );
  }

  cancelComposer(row: SearchRow): void {
    if (this.activeComposer() === row.id) this.activeComposer.set(null);
    this.results.update((list) =>
      list.map((r) => (r.id === row.id ? { ...r, composerOpen: false } : r)),
    );
  }

  sendRequest(row: SearchRow): void {
    if (this.submittingIds().has(row.id)) return;
    const raw = this.messageControl.value?.trim() ?? '';
    this.markSubmitting(row.id, true);
    this.friendsService
      .sendRequest({ toUsername: row.username, ...(raw ? { message: raw } : {}) })
      .subscribe({
        next: () => {
          this.markSubmitting(row.id, false);
          this.activeComposer.set(null);
          // Optimistically flip this row's relationship. The live signal will
          // also update via outgoingRequests so the UI stays consistent.
          this.results.update((list) =>
            list.map((r) =>
              r.id === row.id
                ? { ...r, relationship: 'outgoing_pending' as const, composerOpen: false }
                : r,
            ),
          );
          this.messageControl.setValue('');
        },
        error: (err: HttpErrorResponse) => {
          this.markSubmitting(row.id, false);
          const msg = err.error?.error ?? 'Failed to send friend request.';
          this.snackBar.open(msg, 'Dismiss', { duration: 5000 });
        },
      });
  }

  cancelOutgoing(row: SearchRow): void {
    const id = this.outgoingRequestId(row);
    if (!id || this.submittingIds().has(row.id)) return;
    this.markSubmitting(row.id, true);
    this.friendsService.cancelRequest(id).subscribe({
      next: () => {
        this.markSubmitting(row.id, false);
        this.results.update((list) =>
          list.map((r) =>
            r.id === row.id ? { ...r, relationship: 'none' as const } : r,
          ),
        );
      },
      error: () => {
        this.markSubmitting(row.id, false);
        this.snackBar.open('Failed to cancel request. Please try again.', 'Dismiss', {
          duration: 5000,
        });
      },
    });
  }

  acceptIncoming(row: SearchRow): void {
    const id = this.incomingRequestId(row);
    if (!id || this.submittingIds().has(row.id)) return;
    this.markSubmitting(row.id, true);
    this.friendsService.acceptRequest(id).subscribe({
      next: () => {
        this.markSubmitting(row.id, false);
        this.results.update((list) =>
          list.map((r) =>
            r.id === row.id ? { ...r, relationship: 'friend' as const } : r,
          ),
        );
      },
      error: () => {
        this.markSubmitting(row.id, false);
        this.snackBar.open('Failed to accept request. Please try again.', 'Dismiss', {
          duration: 5000,
        });
      },
    });
  }

  rejectIncoming(row: SearchRow): void {
    const id = this.incomingRequestId(row);
    if (!id || this.submittingIds().has(row.id)) return;
    this.markSubmitting(row.id, true);
    this.friendsService.rejectRequest(id).subscribe({
      next: () => {
        this.markSubmitting(row.id, false);
        this.results.update((list) =>
          list.map((r) =>
            r.id === row.id ? { ...r, relationship: 'none' as const } : r,
          ),
        );
      },
      error: () => {
        this.markSubmitting(row.id, false);
        this.snackBar.open('Failed to reject request. Please try again.', 'Dismiss', {
          duration: 5000,
        });
      },
    });
  }

  isSubmitting(id: string): boolean {
    return this.submittingIds().has(id);
  }

  private markSubmitting(id: string, busy: boolean): void {
    this.submittingIds.update((set) => {
      const next = new Set(set);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }
}
