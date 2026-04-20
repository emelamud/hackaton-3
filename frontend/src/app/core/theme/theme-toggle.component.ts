import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { ThemeService, ThemeMode } from './theme.service';

@Component({
  selector: 'app-theme-toggle',
  standalone: true,
  imports: [MatButtonToggleModule, MatButtonModule, MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <mat-button-toggle-group
      [value]="theme.mode()"
      (change)="theme.set($event.value)"
      aria-label="Theme mode"
      hideSingleSelectionIndicator
    >
      <mat-button-toggle value="light" aria-label="Light">
        <mat-icon>light_mode</mat-icon>
      </mat-button-toggle>
      <mat-button-toggle value="system" aria-label="System">
        <mat-icon>computer</mat-icon>
      </mat-button-toggle>
      <mat-button-toggle value="dark" aria-label="Dark">
        <mat-icon>dark_mode</mat-icon>
      </mat-button-toggle>
    </mat-button-toggle-group>
  `,
})
export class ThemeToggleComponent {
  readonly theme = inject(ThemeService);

  protected trackMode(_: number, mode: ThemeMode): ThemeMode {
    return mode;
  }
}
