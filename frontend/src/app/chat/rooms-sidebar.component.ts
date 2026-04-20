import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { ReactiveFormsModule, FormControl } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatListModule } from '@angular/material/list';
import { RoomsService } from './rooms.service';
import { CreateRoomDialogComponent } from './create-room-dialog.component';
import type { Room } from '../../../../shared/types';

@Component({
  selector: 'app-rooms-sidebar',
  standalone: true,
  imports: [
    RouterLink,
    RouterLinkActive,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatIconModule,
    MatButtonModule,
    MatDialogModule,
    MatSnackBarModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    MatListModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './rooms-sidebar.component.html',
  styleUrl: './rooms-sidebar.component.scss',
})
export class RoomsSidebarComponent implements OnInit {
  private readonly roomsService = inject(RoomsService);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);

  readonly loading = signal(true);
  readonly loadError = signal(false);
  readonly searchControl = new FormControl<string>('', { nonNullable: true });
  readonly search = toSignal(this.searchControl.valueChanges, { initialValue: '' });

  readonly rooms = this.roomsService.roomsSignal;

  readonly filteredRooms = computed(() => {
    const query = (this.search() ?? '').trim().toLowerCase();
    const list = this.rooms();
    if (!query) return list;
    return list.filter((r) => {
      const haystack = `${r.name} ${r.description ?? ''}`.toLowerCase();
      return haystack.includes(query);
    });
  });

  readonly publicRooms = computed<Room[]>(() =>
    this.filteredRooms().filter((r) => r.visibility === 'public'),
  );
  readonly privateRooms = computed<Room[]>(() =>
    this.filteredRooms().filter((r) => r.visibility === 'private'),
  );

  ngOnInit(): void {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.roomsService.refresh().subscribe({
      next: () => this.loading.set(false),
      error: () => {
        this.loading.set(false);
        this.loadError.set(true);
      },
    });
  }

  openCreateDialog(): void {
    this.dialog.open(CreateRoomDialogComponent, {
      width: '28rem',
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
  }
}
