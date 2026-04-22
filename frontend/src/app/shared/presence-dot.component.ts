import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AuthService } from '../core/auth/auth.service';
import { PresenceService } from '../core/presence/presence.service';
import { PresenceActivityService } from '../core/presence/presence-activity.service';
import type { PresenceState } from '@shared';

/**
 * Small coloured dot that renders a user's `online | afk | offline` state.
 *
 * Consumed at four render sites (Round 7):
 *  - Friend rows in the sidebar (LEFT of avatar).
 *  - DM sidebar rows (LEFT of avatar).
 *  - DM header in the room view (LEFT of `@username`).
 *  - Room member rail rows (LEFT of the member's username; self row included).
 *
 * Self-dot branches to `PresenceActivityService.selfState` because the server
 * deliberately omits self-presence from its fan-out (the tab knows its own
 * state locally and would otherwise double-render on every transition).
 *
 * Colour mapping follows the design-system palette map (`DESIGN_SYSTEM.md` §2):
 *  - online → `bg-tertiary`
 *  - afk    → `bg-outline`
 *  - offline → `bg-surface-dim`
 */
@Component({
  selector: 'app-presence-dot',
  standalone: true,
  imports: [MatTooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span
      class="presence-dot"
      [class.bg-tertiary]="state() === 'online'"
      [class.bg-outline]="state() === 'afk'"
      [class.bg-surface-dim]="state() === 'offline'"
      [attr.aria-label]="ariaLabel()"
      [matTooltip]="tooltip()"
      matTooltipPosition="above"
    ></span>
  `,
  styleUrl: './presence-dot.component.scss',
})
export class PresenceDotComponent {
  private readonly presence = inject(PresenceService);
  private readonly activity = inject(PresenceActivityService);
  private readonly auth = inject(AuthService);

  readonly userId = input.required<string>();

  readonly state = computed<PresenceState>(() => {
    const selfId = this.auth.currentUser()?.id ?? null;
    if (selfId !== null && this.userId() === selfId) {
      // Self-dot is never offline — the activity tracker reports 'online' | 'afk'.
      return this.activity.selfState();
    }
    return this.presence.stateFor(this.userId())();
  });

  readonly ariaLabel = computed(() => `Presence: ${this.tooltip()}`);

  readonly tooltip = computed(() => {
    switch (this.state()) {
      case 'online':
        return 'Online';
      case 'afk':
        return 'Away from keyboard';
      default:
        return 'Offline';
    }
  });
}
