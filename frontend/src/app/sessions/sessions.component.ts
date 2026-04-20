import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
  OnInit,
  computed,
} from '@angular/core';
import { Router } from '@angular/router';
import { DatePipe } from '@angular/common';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatChipsModule } from '@angular/material/chips';
import { SessionsService } from './sessions.service';
import { AuthService } from '../core/auth/auth.service';
import type { Session } from '../../../../shared/types';

@Component({
  selector: 'app-sessions',
  standalone: true,
  imports: [
    DatePipe,
    MatTableModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
    MatChipsModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sessions.component.html',
  styleUrl: './sessions.component.scss',
})
export class SessionsComponent implements OnInit {
  private readonly sessionsService = inject(SessionsService);
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private readonly snackBar = inject(MatSnackBar);

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly sessions = signal<Session[]>([]);
  readonly revokingIds = signal<Set<string>>(new Set());

  readonly displayedColumns = ['client', 'ip', 'created', 'expires', 'actions'];

  readonly hasCurrentSession = computed(() => this.sessions().some((s) => s.isCurrent));

  ngOnInit(): void {
    this.loadSessions();
  }

  loadSessions(): void {
    this.loading.set(true);
    this.error.set(null);

    this.sessionsService.getSessions().subscribe({
      next: (sessions) => {
        this.sessions.set(sessions);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Failed to load sessions. Please try again.');
        this.loading.set(false);
      },
    });
  }

  revokeSession(session: Session): void {
    const currentIds = new Set(this.revokingIds());
    currentIds.add(session.id);
    this.revokingIds.set(currentIds);

    this.sessionsService.revokeSession(session.id).subscribe({
      next: () => {
        if (session.isCurrent) {
          // Current session revoked — logout and redirect
          this.authService.logout().subscribe(() => {
            this.router.navigate(['/login']);
          });
        } else {
          this.sessions.update((list) => list.filter((s) => s.id !== session.id));
          const ids = new Set(this.revokingIds());
          ids.delete(session.id);
          this.revokingIds.set(ids);
          this.snackBar.open('Session revoked.', undefined, { duration: 3000 });
        }
      },
      error: () => {
        const ids = new Set(this.revokingIds());
        ids.delete(session.id);
        this.revokingIds.set(ids);
        this.snackBar.open('Failed to revoke session. Please try again.', 'Dismiss', {
          duration: 5000,
        });
      },
    });
  }

  isRevoking(sessionId: string): boolean {
    return this.revokingIds().has(sessionId);
  }

  parseUserAgent(ua: string | null): string {
    if (!ua) return 'Unknown client';

    // Simple parser for common browsers
    if (ua.includes('Edg/')) return 'Microsoft Edge';
    if (ua.includes('Chrome/') && !ua.includes('Chromium')) return 'Chrome';
    if (ua.includes('Firefox/')) return 'Firefox';
    if (ua.includes('Safari/') && !ua.includes('Chrome')) return 'Safari';
    if (ua.includes('Chromium/')) return 'Chromium';

    // OS
    let os = '';
    if (ua.includes('Windows')) os = 'Windows';
    else if (ua.includes('Mac')) os = 'macOS';
    else if (ua.includes('Linux')) os = 'Linux';
    else if (ua.includes('Android')) os = 'Android';
    else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';

    return os ? `Browser on ${os}` : 'Unknown client';
  }
}
