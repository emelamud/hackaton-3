import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../../environments/environment';

/**
 * App-wide Socket.io client.
 *
 * Lifecycle is driven by `AuthService`:
 * - `connect(token)` is called after a successful login / register / refresh.
 * - `disconnect()` is called from `logout()`.
 *
 * Server auto-subscribes each socket to `user:<id>` and every `room:<id>` the
 * user belongs to on connect, and keeps the subscriptions in sync via the
 * REST handlers. Clients must **not** emit `room:join` / `room:leave`.
 */
type Listener = { event: string; handler: (payload: unknown) => void };

@Injectable({ providedIn: 'root' })
export class SocketService {
  private socket: Socket | null = null;
  private currentToken: string | null = null;
  // Subscribers registered via `on()` survive reconnects: each entry is
  // (re-)attached on every `connect()` so root-scoped services can subscribe
  // before the socket exists.
  private readonly listeners = new Set<Listener>();

  /**
   * Idempotent. If a socket already exists with the same token, no-op.
   * If it exists with a different token, disconnect and create a fresh socket.
   */
  connect(token: string): void {
    if (this.socket && this.currentToken === token) {
      if (!this.socket.connected) {
        this.socket.connect();
      }
      return;
    }

    if (this.socket) {
      this.detachListeners(this.socket);
      this.socket.disconnect();
      this.socket = null;
    }

    this.currentToken = token;
    this.socket = io(environment.socketUrl, {
      auth: { token },
      autoConnect: true,
      transports: ['websocket', 'polling'],
      withCredentials: true,
    });

    this.attachListeners(this.socket);

    this.socket.on('connect_error', (err) => {
      // Surface connection-level failures to the console; business-logic
      // failures flow through the ack envelope instead.
      console.warn('[socket] connect_error:', err.message);
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.detachListeners(this.socket);
      this.socket.disconnect();
      this.socket = null;
    }
    this.currentToken = null;
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  /**
   * Cold Observable: registers a listener that stays alive across reconnects.
   * Each subscriber gets its own handler so `takeUntilDestroyed()` cleans up
   * properly when a component is disposed.
   */
  on<T>(event: string): Observable<T> {
    return new Observable<T>((observer) => {
      const handler = (payload: T) => observer.next(payload);
      const entry: Listener = { event, handler: handler as (payload: unknown) => void };
      this.listeners.add(entry);
      this.socket?.on(event, handler);
      return () => {
        this.listeners.delete(entry);
        this.socket?.off(event, handler);
      };
    });
  }

  private attachListeners(socket: Socket): void {
    for (const { event, handler } of this.listeners) {
      socket.on(event, handler);
    }
  }

  private detachListeners(socket: Socket): void {
    for (const { event, handler } of this.listeners) {
      socket.off(event, handler);
    }
  }

  /**
   * Emit an event with an ack callback. Resolves with the ack payload, or
   * rejects if the server does not ack within 5 seconds or returns an error.
   */
  emitWithAck<Req, Res>(event: string, payload: Req): Promise<Res> {
    return new Promise<Res>((resolve, reject) => {
      const socket = this.socket;
      if (!socket) {
        reject(new Error('Socket not connected'));
        return;
      }
      socket.timeout(5000).emit(event, payload, (err: unknown, res: Res) => {
        if (err) {
          reject(err instanceof Error ? err : new Error('Socket request timed out'));
          return;
        }
        resolve(res);
      });
    });
  }
}
