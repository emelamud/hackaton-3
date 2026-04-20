import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule, MatMenuTrigger } from '@angular/material/menu';
import { MatDividerModule } from '@angular/material/divider';
import { MatBadgeModule } from '@angular/material/badge';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { AuthService } from '../core/auth/auth.service';
import { InvitationsService } from '../core/invitations/invitations.service';
import { InvitationItemComponent } from '../core/invitations/invitation-item.component';
import type { Invitation } from '../../../../shared/types';

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
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './shell.component.html',
  styleUrl: './shell.component.scss',
})
export class ShellComponent {
  protected readonly authService = inject(AuthService);
  protected readonly invitationsService = inject(InvitationsService);
  private readonly router = inject(Router);
  private readonly snackBar = inject(MatSnackBar);

  readonly signingOut = signal(false);
  /** Disable buttons on a row while its accept/reject is in flight. */
  readonly busyIds = signal<ReadonlySet<string>>(new Set());

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
