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
} from '../../../../../shared/types';
import type { User } from '../../../../../shared/types';
import { SocketService } from '../socket/socket.service';
import { InvitationsService } from '../invitations/invitations.service';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly socketService = inject(SocketService);
  private readonly invitationsService = inject(InvitationsService);

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
      this.socketService.connect(this.accessToken);
      // Seed pending invitations for the restored session.
      this.invitationsService.fetchInitial().subscribe({ error: () => undefined });
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
        this.socketService.connect(res.accessToken);
        this.invitationsService.fetchInitial().subscribe({ error: () => undefined });
      }),
    );
  }

  register(payload: RegisterRequest): Observable<AuthResponse> {
    return this.http.post<AuthResponse>(`${this.baseUrl}/register`, payload).pipe(
      tap((res) => {
        this.setAccessToken(res.accessToken);
        this.currentUser.set(res.user);
        this.socketService.connect(res.accessToken);
        this.invitationsService.fetchInitial().subscribe({ error: () => undefined });
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
          // On silent refresh during app boot, ensure the socket is connected.
          // Mid-session refreshes do not reconnect — see Round 3 summary.
          if (!this.socketService.isConnected()) {
            this.socketService.connect(res.accessToken);
          }
          // Re-seed pending invitations on (re)authentication.
          this.invitationsService.fetchInitial().subscribe({ error: () => undefined });
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
