import { DOCUMENT } from '@angular/common';
import { Injectable, NgZone, inject, signal } from '@angular/core';
import { SocketService } from '../socket/socket.service';

/**
 * Own-tab activity tracker.
 *
 * Wires document-level user-interaction listeners + Page Visibility to drive
 * the 60 s idle threshold (contract §Presence rules). Emits `presence:active`
 * / `presence:idle` to the server on aggregate-state transitions only — not
 * on every mousemove. Also exposes a local `selfState` signal so the own-user
 * presence dot renders without a round-trip through the server-sourced map
 * (the server never self-broadcasts).
 *
 * Listeners are attached inside `NgZone.runOutsideAngular` so activity events
 * don't trigger change-detection thousands of times per minute; the zone is
 * re-entered only on real transitions (≤ 2/minute under normal use).
 *
 * Lifecycle is driven by `AuthService`:
 *  - `start()` — called on login / register / session-restore.
 *  - `stop()` — called on logout (via `clearSession`).
 *
 * `selfState` is `'online' | 'afk'` — never `'offline'`. Offline is a
 * server-computed aggregate that fires when ALL of a user's sockets close;
 * by definition, the tab rendering this signal is not one of those.
 */
@Injectable({ providedIn: 'root' })
export class PresenceActivityService {
  private readonly socketService = inject(SocketService);
  private readonly zone = inject(NgZone);
  private readonly document = inject(DOCUMENT);

  /** AFK threshold per the contract (requirement §2.2.2). */
  private readonly AFK_MS = 60_000;

  /** Qualifying user-interaction events. Captured + passive so we never block scroll / typing. */
  private readonly EVENTS = [
    'mousedown',
    'mousemove',
    'wheel',
    'scroll',
    'keydown',
    'pointerdown',
    'touchstart',
  ] as const;

  /**
   * Own-tab presence for the UI. `'online'` while interacting, `'afk'` after
   * 60 s of no qualifying events OR when the tab goes hidden. Never `'offline'`.
   */
  readonly selfState = signal<'online' | 'afk'>('online');

  private timerId: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private removeDomListeners: (() => void) | null = null;

  /** Idempotent. Called from `AuthService` after successful auth. */
  start(): void {
    if (this.started) return;
    this.started = true;

    this.zone.runOutsideAngular(() => {
      const onActivity = (): void => this.reportActivity();
      const onVisibility = (): void => {
        if (this.document.visibilityState === 'hidden') {
          this.transitionTo('afk');
        } else {
          this.reportActivity();
        }
      };

      for (const eventName of this.EVENTS) {
        this.document.addEventListener(eventName, onActivity, { capture: true, passive: true });
      }
      this.document.addEventListener('visibilitychange', onVisibility);

      this.removeDomListeners = () => {
        for (const eventName of this.EVENTS) {
          this.document.removeEventListener(eventName, onActivity, {
            capture: true,
          } as EventListenerOptions);
        }
        this.document.removeEventListener('visibilitychange', onVisibility);
      };
    });

    // Seed: we're started because the user just authenticated or restored a
    // session — they interacted to get here. Emit `presence:active` so the
    // server's per-socket state matches the FE's local starting state.
    this.reportActivity();
  }

  /** Idempotent. Called from `AuthService.clearSession()` on logout. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.clearTimer();
    this.removeDomListeners?.();
    this.removeDomListeners = null;
    this.selfState.set('online');
  }

  /** Called by every qualifying DOM event + `visibilitychange → visible`. */
  private reportActivity(): void {
    this.transitionTo('online');
    this.clearTimer();
    // `setTimeout` runs outside the zone because it was scheduled inside
    // `runOutsideAngular`. The zone re-entry happens only on an actual
    // transition (see `transitionTo`).
    this.timerId = setTimeout(() => {
      this.transitionTo('afk');
    }, this.AFK_MS);
  }

  private transitionTo(state: 'online' | 'afk'): void {
    if (this.selfState() === state) return;
    // Re-enter the zone only for the transition so templates bound to
    // `selfState` refresh deterministically.
    this.zone.run(() => this.selfState.set(state));
    this.socketService.emit(state === 'online' ? 'presence:active' : 'presence:idle');
  }

  private clearTimer(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }
}
