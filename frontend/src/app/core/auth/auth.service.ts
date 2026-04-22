import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable, catchError, of, tap } from 'rxjs';
import { environment } from '../../../environments/environment';
import type {
  AuthResponse,
  LoginRequest,
  RegisterRequest,
  ForgotPasswordRequest,
  ResetPasswordRequest,
  RefreshResponse,
} from '@shared';
import type { User } from '@shared';
import { SocketService } from '../socket/socket.service';
import { InvitationsService } from '../invitations/invitations.service';
import { FriendsService } from '../friends/friends.service';
import { UserBansService } from '../user-bans/user-bans.service';
import { DmsService } from '../dms/dms.service';
import { PresenceService } from '../presence/presence.service';
import { PresenceActivityService } from '../presence/presence-activity.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { UnreadService } from '../unread/unread.service';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly socketService = inject(SocketService);
  private readonly invitationsService = inject(InvitationsService);
  private readonly friendsService = inject(FriendsService);
  private readonly userBansService = inject(UserBansService);
  // Eagerly instantiate `DmsService` so its `dm:created` socket subscription is
  // active before the first DM arrives. The reference is retained on `this`
  // so `strict` TS tree-shaking / unused-locals lint rules don't flag it.
  protected readonly dmsService = inject(DmsService);
  // Same eager-construction pattern: `PresenceService`'s `presence:snapshot` /
  // `presence:update` subscriptions have to be attached before the socket
  // connects so the first snapshot lands in the map. `PresenceActivityService`
  // owns the own-tab activity tracker and is driven via `start()` / `stop()`.
  protected readonly presenceService = inject(PresenceService);
  private readonly presenceActivityService = inject(PresenceActivityService);
  // Eager-construction parity with the other session-scoped services above.
  // `AttachmentsService` owns a blob + object-URL cache that must be revoked
  // from `clearSession()` to prevent cross-session URL leaks.
  private readonly attachmentsService = inject(AttachmentsService);
  // Round 12: the unread counter also needs to be live before the first
  // `message:new` arrives so its socket subscriptions can bump per-room
  // counts. `initialize()` seeds the map from `GET /api/unread`. The caller's
  // user id is pushed into `UnreadService` via `setCurrentUserId()` after
  // every `currentUser.set()` call below, so `UnreadService` itself does not
  // need to inject `AuthService` (keeps the DI graph acyclic).
  private readonly unreadService = inject(UnreadService);

  private readonly baseUrl = `${environment.apiUrl}/auth`;

  private static readonly TOKEN_KEY = 'chat.accessToken';

  private storage: Storage =
    localStorage.getItem(AuthService.TOKEN_KEY) !== null ? localStorage : sessionStorage;

  private accessToken: string | null = this.storage.getItem(AuthService.TOKEN_KEY);

  readonly currentUser = signal<User | null>(
    this.accessToken ? this.decodeUser(this.accessToken) : null,
  );
  readonly isAuthenticated = computed(() => {
    if (this.currentUser() !== null) return true;
    const token = this.storage.getItem(AuthService.TOKEN_KEY);
    return token !== null && this.decodeUser(token) !== null;
  });

  constructor() {
    if (!this.currentUser()) this.hydrateFromStorage();
    // If a token survived a reload (in storage), connect the socket now.
    if (this.accessToken) {
      this.unreadService.setCurrentUserId(this.currentUser()?.id ?? null);
      this.socketService.connect(this.accessToken);
      // Seed pending invitations + friends + bans state for the restored session.
      this.invitationsService.fetchInitial().subscribe({ error: () => undefined });
      this.friendsService.fetchInitial().subscribe({ error: () => undefined });
      this.userBansService.fetchInitial().subscribe({ error: () => undefined });
      this.unreadService.initialize().subscribe({ error: () => undefined });
      // Presence: server pushes `presence:snapshot` on socket connect; the
      // activity tracker starts reporting `presence:active`/`presence:idle`.
      this.presenceActivityService.start();
    }
  }

  getAccessToken(): string | null {
    if (!this.accessToken) this.hydrateFromStorage();
    return this.accessToken;
  }

  private hydrateFromStorage(): User | null {
    const token = this.storage.getItem(AuthService.TOKEN_KEY);
    if (!token) return null;
    const user = this.decodeUser(token);
    if (!user) {
      this.storage.removeItem(AuthService.TOKEN_KEY);
      return null;
    }
    this.accessToken = token;
    this.currentUser.set(user);
    return user;
  }

  private setAccessToken(token: string): void {
    this.accessToken = token;
    this.storage.setItem(AuthService.TOKEN_KEY, token);
  }

  private selectStorage(keepSignedIn: boolean): void {
    const next = keepSignedIn ? localStorage : sessionStorage;
    const other = keepSignedIn ? sessionStorage : localStorage;
    other.removeItem(AuthService.TOKEN_KEY);
    this.storage = next;
  }

  login(payload: LoginRequest): Observable<AuthResponse> {
    return this.http.post<AuthResponse>(`${this.baseUrl}/login`, payload).pipe(
      tap((res) => {
        this.selectStorage(payload.keepSignedIn ?? false);
        this.setAccessToken(res.accessToken);
        this.currentUser.set(res.user);
        this.unreadService.setCurrentUserId(res.user.id);
        this.socketService.connect(res.accessToken);
        this.invitationsService.fetchInitial().subscribe({ error: () => undefined });
        this.friendsService.fetchInitial().subscribe({ error: () => undefined });
        this.userBansService.fetchInitial().subscribe({ error: () => undefined });
        this.unreadService.initialize().subscribe({ error: () => undefined });
        this.presenceActivityService.start();
      }),
    );
  }

  register(payload: RegisterRequest): Observable<AuthResponse> {
    return this.http.post<AuthResponse>(`${this.baseUrl}/register`, payload).pipe(
      tap((res) => {
        this.setAccessToken(res.accessToken);
        this.currentUser.set(res.user);
        this.unreadService.setCurrentUserId(res.user.id);
        this.socketService.connect(res.accessToken);
        this.invitationsService.fetchInitial().subscribe({ error: () => undefined });
        this.friendsService.fetchInitial().subscribe({ error: () => undefined });
        this.userBansService.fetchInitial().subscribe({ error: () => undefined });
        this.unreadService.initialize().subscribe({ error: () => undefined });
        this.presenceActivityService.start();
      }),
    );
  }

  logout(): Observable<void> {
    this.socketService.disconnect();
    return this.http.post<void>(`${this.baseUrl}/logout`, {}).pipe(
      tap(() => this.clearSession()),
      catchError(() => {
        this.clearSession();
        return of(undefined);
      }),
    );
  }

  refresh(): Observable<RefreshResponse | null> {
    return this.http
      .post<RefreshResponse>(`${this.baseUrl}/refresh`, {}, { withCredentials: true })
      .pipe(
        tap((res) => {
          this.setAccessToken(res.accessToken);
          this.setUserFromToken(res.accessToken);
          this.unreadService.setCurrentUserId(this.currentUser()?.id ?? null);
          // On silent refresh during app boot, ensure the socket is connected.
          // Mid-session refreshes do not reconnect — see Round 3 summary.
          if (!this.socketService.isConnected()) {
            this.socketService.connect(res.accessToken);
          }
          // Re-seed pending invitations + friends + bans on (re)authentication.
          this.invitationsService.fetchInitial().subscribe({ error: () => undefined });
          this.friendsService.fetchInitial().subscribe({ error: () => undefined });
          this.userBansService.fetchInitial().subscribe({ error: () => undefined });
          this.unreadService.initialize().subscribe({ error: () => undefined });
          // Idempotent — if a prior constructor or login already started the
          // tracker, this is a no-op.
          this.presenceActivityService.start();
        }),
        catchError(() => {
          this.clearSession();
          return of(null);
        }),
      );
  }

  forgotPassword(payload: ForgotPasswordRequest): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/forgot-password`, payload);
  }

  resetPassword(payload: ResetPasswordRequest): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/reset-password`, payload);
  }

  private clearSession(): void {
    this.accessToken = null;
    localStorage.removeItem(AuthService.TOKEN_KEY);
    sessionStorage.removeItem(AuthService.TOKEN_KEY);
    this.storage = sessionStorage;
    this.currentUser.set(null);
    this.socketService.disconnect();
    this.invitationsService.pending.set([]);
    this.friendsService.reset();
    this.userBansService.reset();
    this.unreadService.reset();
    // Stop the DOM-level activity listeners + wipe the server-sourced map.
    this.presenceActivityService.stop();
    this.presenceService.reset();
    // Revoke every live `blob:` URL so the next user can't resolve URLs
    // minted for the previous session's attachments.
    this.attachmentsService.reset();
  }

  private setUserFromToken(token: string): void {
    const user = this.decodeUser(token);
    if (user) this.currentUser.set(user);
  }

  private decodeUser(token: string): User | null {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload?.email && payload?.username) {
        return {
          id: payload.sub,
          email: payload.email,
          username: payload.username,
          createdAt: payload.createdAt ?? '',
        };
      }
    } catch (e) {
      console.error('Error decoding token:', e);
    }
    return null;
  }
}
