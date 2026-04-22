import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { ReactiveFormsModule, FormControl } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatListModule } from '@angular/material/list';
import { MatMenuModule } from '@angular/material/menu';
import { MatBadgeModule } from '@angular/material/badge';
import { RoomsService } from './rooms.service';
import { CreateRoomDialogComponent } from './create-room-dialog.component';
import { FriendsService } from '../core/friends/friends.service';
import { UnreadService } from '../core/unread/unread.service';
import { AddFriendDialogComponent } from '../core/friends/add-friend-dialog.component';
import { RemoveFriendDialogComponent } from '../core/friends/remove-friend-dialog.component';
import { DmsService } from '../core/dms/dms.service';
import { UserBansService } from '../core/user-bans/user-bans.service';
import {
  BlockUserDialogComponent,
  type BlockUserDialogData,
} from '../core/user-bans/block-user-dialog.component';
import { PresenceDotComponent } from '../shared/presence-dot.component';
import type { Friend, FriendRequest, Room } from '@shared';

@Component({
  selector: 'app-rooms-sidebar',
  standalone: true,
  imports: [
    RouterLink,
    RouterLinkActive,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatIconModule,
    MatButtonModule,
    MatDialogModule,
    MatSnackBarModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    MatListModule,
    MatMenuModule,
    MatBadgeModule,
    PresenceDotComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './rooms-sidebar.component.html',
  styleUrl: './rooms-sidebar.component.scss',
})
export class RoomsSidebarComponent implements OnInit {
  private readonly roomsService = inject(RoomsService);
  protected readonly friendsService = inject(FriendsService);
  protected readonly userBansService = inject(UserBansService);
  protected readonly unreadService = inject(UnreadService);
  private readonly dmsService = inject(DmsService);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);
  private readonly router = inject(Router);

  readonly friendsExpanded = signal(true);
  readonly dmsExpanded = signal(true);
  readonly outgoingExpanded = signal(false);
  readonly removingIds = signal<ReadonlySet<string>>(new Set());
  readonly cancellingIds = signal<ReadonlySet<string>>(new Set());
  readonly openingDmIds = signal<ReadonlySet<string>>(new Set());
  readonly blockingIds = signal<ReadonlySet<string>>(new Set());

  readonly loading = signal(true);
  readonly loadError = signal(false);
  readonly searchControl = new FormControl<string>('', { nonNullable: true });
  readonly search = toSignal(this.searchControl.valueChanges, { initialValue: '' });

  readonly rooms = this.roomsService.roomsSignal;

  readonly filteredRooms = computed(() => {
    const query = (this.search() ?? '').trim().toLowerCase();
    const list = this.rooms();
    if (!query) return list;
    return list.filter((r) => {
      // Channels match against name/description; DMs match against the peer's username.
      if (r.type === 'dm') {
        return (r.dmPeer?.username ?? '').toLowerCase().includes(query);
      }
      const haystack = `${r.name ?? ''} ${r.description ?? ''}`.toLowerCase();
      return haystack.includes(query);
    });
  });

  /**
   * Channel rooms only — DMs are rendered in their own section and should not
   * show up in the Public / Private groups (DMs are always `visibility='private'`
   * and would otherwise leak into the Private group).
   */
  readonly publicRooms = computed<Room[]>(() =>
    this.filteredRooms().filter((r) => r.type === 'channel' && r.visibility === 'public'),
  );
  readonly privateRooms = computed<Room[]>(() =>
    this.filteredRooms().filter((r) => r.type === 'channel' && r.visibility === 'private'),
  );

  readonly dmRooms = computed<Room[]>(() =>
    this.filteredRooms().filter((r) => r.type === 'dm'),
  );

  ngOnInit(): void {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.roomsService.refresh().subscribe({
      next: () => this.loading.set(false),
      error: () => {
        this.loading.set(false);
        this.loadError.set(true);
      },
    });
  }

  openCreateDialog(): void {
    this.dialog.open(CreateRoomDialogComponent, {
      width: '28rem',
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
  }

  openAddFriendDialog(): void {
    this.dialog.open(AddFriendDialogComponent, {
      width: '32rem',
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
  }

  toggleFriends(): void {
    this.friendsExpanded.update((v) => !v);
  }

  toggleDms(): void {
    this.dmsExpanded.update((v) => !v);
  }

  toggleOutgoing(): void {
    this.outgoingExpanded.update((v) => !v);
  }

  /**
   * Message action on a friend row — opens (or creates) the DM and navigates.
   * Guards against double-click via `openingDmIds`; surfaces the contract's
   * two 403 strings verbatim in a snackbar when the race loses.
   */
  messageFriend(friend: Friend): void {
    if (this.userBansService.isBanned(friend.userId)) return;
    if (this.openingDmIds().has(friend.userId)) return;
    this.markOpeningDm(friend.userId, true);
    this.dmsService.openDm(friend.userId).subscribe({
      next: (room) => {
        this.markOpeningDm(friend.userId, false);
        this.router.navigate(['/chat', room.id]);
      },
      error: (err: HttpErrorResponse) => {
        this.markOpeningDm(friend.userId, false);
        const msg =
          err.status === 403
            ? err.error?.error ?? 'Cannot open direct message.'
            : 'Failed to open direct message. Please try again.';
        this.snackBar.open(msg, 'Dismiss', { duration: 5000 });
      },
    });
  }

  /** Block a friend — opens the confirmation dialog; on confirm POSTs to `/api/user-bans`. */
  blockFriend(friend: Friend): void {
    this.openBlockDialog(friend.userId, friend.username);
  }

  /** Block a DM peer — same flow as `blockFriend` but triggered from the DM row. */
  blockDmPeer(room: Room): void {
    if (!room.dmPeer) return;
    this.openBlockDialog(room.dmPeer.userId, room.dmPeer.username);
  }

  private openBlockDialog(userId: string, username: string): void {
    if (this.blockingIds().has(userId)) return;
    const data: BlockUserDialogData = { username };
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
        this.markBlocking(userId, true);
        this.userBansService.block(userId).subscribe({
          next: () => this.markBlocking(userId, false),
          error: (err: HttpErrorResponse) => {
            this.markBlocking(userId, false);
            const msg = err.error?.error ?? 'Failed to block user. Please try again.';
            this.snackBar.open(msg, 'Dismiss', { duration: 5000 });
          },
        });
      });
  }

  removeFriend(friend: Friend): void {
    if (this.removingIds().has(friend.userId)) return;
    const ref = this.dialog.open(RemoveFriendDialogComponent, {
      width: '24rem',
      data: { username: friend.username },
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
    ref.afterClosed().subscribe((confirmed) => {
      if (!confirmed) return;
      this.markRemoving(friend.userId, true);
      this.friendsService.removeFriend(friend.userId).subscribe({
        next: () => {
          this.markRemoving(friend.userId, false);
        },
        error: () => {
          this.markRemoving(friend.userId, false);
          this.snackBar.open('Failed to remove friend. Please try again.', 'Dismiss', {
            duration: 5000,
          });
        },
      });
    });
  }

  cancelOutgoing(request: FriendRequest): void {
    if (this.cancellingIds().has(request.id)) return;
    this.markCancelling(request.id, true);
    this.friendsService.cancelRequest(request.id).subscribe({
      next: () => this.markCancelling(request.id, false),
      error: () => {
        this.markCancelling(request.id, false);
        this.snackBar.open('Failed to cancel request. Please try again.', 'Dismiss', {
          duration: 5000,
        });
      },
    });
  }

  isRemoving(id: string): boolean {
    return this.removingIds().has(id);
  }

  isCancelling(id: string): boolean {
    return this.cancellingIds().has(id);
  }

  isOpeningDm(id: string): boolean {
    return this.openingDmIds().has(id);
  }

  isBanned(userId: string): boolean {
    return this.userBansService.isBanned(userId);
  }

  /**
   * Unread count lookup for `[matBadge]`. Returns `null` when zero so the
   * badge is hidden entirely (passing `0` would render a "0" dot). The lookup
   * dereferences the signal so change detection re-runs when counts mutate.
   */
  unreadBadge(roomId: string): number | null {
    return this.unreadService.unreadByRoomId().get(roomId) ?? null;
  }

  private markRemoving(id: string, busy: boolean): void {
    this.removingIds.update((set) => {
      const next = new Set(set);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  private markCancelling(id: string, busy: boolean): void {
    this.cancellingIds.update((set) => {
      const next = new Set(set);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  private markOpeningDm(id: string, busy: boolean): void {
    this.openingDmIds.update((set) => {
      const next = new Set(set);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  private markBlocking(id: string, busy: boolean): void {
    this.blockingIds.update((set) => {
      const next = new Set(set);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }
}
