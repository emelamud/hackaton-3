import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule, MatMenuTrigger } from '@angular/material/menu';
import { MatDividerModule } from '@angular/material/divider';
import { MatBadgeModule } from '@angular/material/badge';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { AuthService } from '../core/auth/auth.service';
import { InvitationsService } from '../core/invitations/invitations.service';
import { InvitationItemComponent } from '../core/invitations/invitation-item.component';
import { FriendsService } from '../core/friends/friends.service';
import { FriendRequestItemComponent } from '../core/friends/friend-request-item.component';
import { BlockedUsersDialogComponent } from '../core/user-bans/blocked-users-dialog.component';
import type { Invitation, FriendRequest } from '@shared';

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [
    RouterOutlet,
    RouterLink,
    MatToolbarModule,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
    MatDividerModule,
    MatBadgeModule,
    MatSnackBarModule,
    InvitationItemComponent,
    FriendRequestItemComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './shell.component.html',
  styleUrl: './shell.component.scss',
})
export class ShellComponent {
  protected readonly authService = inject(AuthService);
  protected readonly invitationsService = inject(InvitationsService);
  protected readonly friendsService = inject(FriendsService);
  private readonly router = inject(Router);
  private readonly snackBar = inject(MatSnackBar);
  private readonly dialog = inject(MatDialog);

  readonly signingOut = signal(false);
  /** Disable buttons on a row while its accept/reject is in flight. */
  readonly busyIds = signal<ReadonlySet<string>>(new Set());

  openBlockedUsers(): void {
    this.dialog.open(BlockedUsersDialogComponent, {
      width: '28rem',
      maxWidth: '95vw',
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
  }

  signOut(): void {
    this.signingOut.set(true);
    this.authService.logout().subscribe({
      next: () => {
        this.router.navigate(['/login']);
      },
      error: () => {
        this.signingOut.set(false);
        this.snackBar.open('Sign out failed. Please try again.', 'Dismiss', { duration: 5000 });
      },
    });
  }

  onAccept(invitation: Invitation, menuTrigger: MatMenuTrigger): void {
    this.markBusy(invitation.id, true);
    this.invitationsService.accept(invitation.id).subscribe({
      next: () => {
        this.markBusy(invitation.id, false);
        menuTrigger.closeMenu();
        this.router.navigate(['/chat', invitation.roomId]);
      },
      error: () => {
        this.markBusy(invitation.id, false);
        this.snackBar.open('Failed to accept invitation. Please try again.', 'Dismiss', {
          duration: 5000,
        });
      },
    });
  }

  onReject(invitation: Invitation, menuTrigger: MatMenuTrigger): void {
    this.markBusy(invitation.id, true);
    this.invitationsService.reject(invitation.id).subscribe({
      next: () => {
        this.markBusy(invitation.id, false);
        // Close menu only if that was the last pending invitation.
        if (this.invitationsService.pendingCount() === 0) {
          menuTrigger.closeMenu();
        }
      },
      error: () => {
        this.markBusy(invitation.id, false);
        this.snackBar.open('Failed to reject invitation. Please try again.', 'Dismiss', {
          duration: 5000,
        });
      },
    });
  }

  onAcceptFriend(request: FriendRequest, menuTrigger: MatMenuTrigger): void {
    this.markBusy(request.id, true);
    this.friendsService.acceptRequest(request.id).subscribe({
      next: () => {
        this.markBusy(request.id, false);
        this.snackBar.open(
          `You and @${request.fromUsername} are now friends`,
          'Dismiss',
          { duration: 4000 },
        );
        if (this.friendsService.incomingCount() === 0) {
          menuTrigger.closeMenu();
        }
      },
      error: () => {
        this.markBusy(request.id, false);
        this.snackBar.open('Failed to accept friend request. Please try again.', 'Dismiss', {
          duration: 5000,
        });
      },
    });
  }

  onRejectFriend(request: FriendRequest, menuTrigger: MatMenuTrigger): void {
    this.markBusy(request.id, true);
    this.friendsService.rejectRequest(request.id).subscribe({
      next: () => {
        this.markBusy(request.id, false);
        if (this.friendsService.incomingCount() === 0) {
          menuTrigger.closeMenu();
        }
      },
      error: () => {
        this.markBusy(request.id, false);
        this.snackBar.open('Failed to reject friend request. Please try again.', 'Dismiss', {
          duration: 5000,
        });
      },
    });
  }

  isBusy(id: string): boolean {
    return this.busyIds().has(id);
  }

  private markBusy(id: string, busy: boolean): void {
    this.busyIds.update((set) => {
      const next = new Set(set);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }
}
