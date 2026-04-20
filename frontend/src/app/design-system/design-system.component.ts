import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { MatBadgeModule } from '@angular/material/badge';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatToolbarModule } from '@angular/material/toolbar';
import { TextFieldModule } from '@angular/cdk/text-field';
import { ThemeToggleComponent } from '../core/theme/theme-toggle.component';

interface Swatch {
  bg: string;
  on?: string;
  label: string;
}

@Component({
  selector: 'app-design-system',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    TextFieldModule,
    MatBadgeModule,
    MatButtonModule,
    MatCardModule,
    MatChipsModule,
    MatDialogModule,
    MatDividerModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSidenavModule,
    MatSnackBarModule,
    MatToolbarModule,
    ThemeToggleComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './design-system.component.html',
  styleUrl: './design-system.component.scss',
})
export class DesignSystemComponent {
  private readonly fb = inject(FormBuilder);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);

  readonly typographyRoles = [
    'display-large',
    'display-medium',
    'display-small',
    'headline-large',
    'headline-medium',
    'headline-small',
    'title-large',
    'title-medium',
    'title-small',
    'body-large',
    'body-medium',
    'body-small',
    'label-large',
    'label-medium',
    'label-small',
  ] as const;

  readonly spacingSteps = ['0', '1', '2', '3', '4', '5', '6', '7', '8'] as const;

  readonly rolePairs: Swatch[] = [
    { bg: 'primary', on: 'on-primary', label: 'primary' },
    { bg: 'primary-container', on: 'on-primary-container', label: 'primary-container' },
    { bg: 'secondary', on: 'on-secondary', label: 'secondary' },
    { bg: 'secondary-container', on: 'on-secondary-container', label: 'secondary-container' },
    { bg: 'tertiary', on: 'on-tertiary', label: 'tertiary' },
    { bg: 'tertiary-container', on: 'on-tertiary-container', label: 'tertiary-container' },
    { bg: 'error', on: 'on-error', label: 'error' },
    { bg: 'error-container', on: 'on-error-container', label: 'error-container' },
  ];

  readonly surfaces: Swatch[] = [
    { bg: 'background', on: 'on-background', label: 'background' },
    { bg: 'surface', on: 'on-surface', label: 'surface' },
    { bg: 'surface-dim', on: 'on-surface', label: 'surface-dim' },
    { bg: 'surface-bright', on: 'on-surface', label: 'surface-bright' },
    { bg: 'surface-container-lowest', on: 'on-surface', label: 'surface-container-lowest' },
    { bg: 'surface-container-low', on: 'on-surface', label: 'surface-container-low' },
    { bg: 'surface-container', on: 'on-surface', label: 'surface-container' },
    { bg: 'surface-container-high', on: 'on-surface', label: 'surface-container-high' },
    { bg: 'surface-container-highest', on: 'on-surface', label: 'surface-container-highest' },
    { bg: 'inverse-surface', on: 'inverse-on-surface', label: 'inverse-surface' },
  ];

  readonly form = this.fb.group({
    name: this.fb.control('', Validators.required),
    email: this.fb.control('', [Validators.required, Validators.email]),
    message: this.fb.control(''),
  });

  readonly channels = [
    { name: 'general', unread: 3, active: true },
    { name: 'random', unread: 0, active: false },
    { name: 'frontend', unread: 12, active: false },
    { name: 'design-system', unread: 0, active: false },
  ];

  readonly messages = [
    {
      author: 'Sam Carter',
      time: '9:42 AM',
      body: 'Pushed the design-system skill plan. Take a look when you get a chance.',
    },
    {
      author: 'Jamie Chen',
      time: '9:44 AM',
      body: 'Looks solid — the role-based utilities are the right call.',
    },
    {
      author: 'Alex Rivera',
      time: '9:47 AM',
      body: 'Dark mode toggle works in the demo. Nice.',
    },
  ];

  openDialog(): void {
    this.dialog.open(DemoDialogComponent, { width: '28rem' });
  }

  openSnackbar(): void {
    this.snackBar.open('Message sent', 'Undo', { duration: 4000 });
  }
}

@Component({
  selector: 'app-demo-dialog',
  standalone: true,
  imports: [MatButtonModule, MatDialogModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title class="text-title-large">Leave this channel?</h2>
    <mat-dialog-content class="text-body-medium text-on-surface-variant">
      You will no longer receive messages from #general. You can rejoin at any time.
    </mat-dialog-content>
    <mat-dialog-actions align="end" class="gap-2">
      <button mat-button [mat-dialog-close]="false">Cancel</button>
      <button mat-flat-button color="primary" [mat-dialog-close]="true">Leave</button>
    </mat-dialog-actions>
  `,
})
export class DemoDialogComponent {
  protected readonly ref = inject(MatDialogRef<DemoDialogComponent>);
}
