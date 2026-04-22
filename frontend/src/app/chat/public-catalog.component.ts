import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { debounceTime, distinctUntilChanged } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { CatalogService } from './catalog.service';
import { RoomsService } from './rooms.service';
import type { PublicRoomCatalogEntry } from '@shared';

const PAGE_LIMIT = 20;
const SEARCH_DEBOUNCE_MS = 300;

@Component({
  selector: 'app-public-catalog',
  standalone: true,
  imports: [
    RouterLink,
    ReactiveFormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './public-catalog.component.html',
  styleUrl: './public-catalog.component.scss',
})
export class PublicCatalogComponent implements OnInit {
  private readonly catalog = inject(CatalogService);
  private readonly roomsService = inject(RoomsService);
  private readonly router = inject(Router);
  private readonly snackBar = inject(MatSnackBar);
  private readonly destroyRef = inject(DestroyRef);

  readonly searchControl = new FormControl<string>('', { nonNullable: true });

  readonly rooms = signal<PublicRoomCatalogEntry[]>([]);
  readonly loading = signal(false);
  readonly loadingMore = signal(false);
  readonly hasMore = signal(false);
  readonly nextCursor = signal<string | null>(null);
  readonly loadError = signal(false);
  readonly joiningIds = signal<ReadonlySet<string>>(new Set());

  ngOnInit(): void {
    this.loadInitial();
    this.searchControl.valueChanges
      .pipe(
        debounceTime(SEARCH_DEBOUNCE_MS),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.loadInitial());
  }

  retry(): void {
    this.loadInitial();
  }

  loadMore(): void {
    const cursor = this.nextCursor();
    if (!cursor || this.loadingMore()) return;
    this.loadingMore.set(true);
    this.catalog
      .list({ q: this.searchControl.value, cursor, limit: PAGE_LIMIT })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.rooms.update((list) => {
            const seen = new Set(list.map((r) => r.id));
            const deduped = res.rooms.filter((r) => !seen.has(r.id));
            return [...list, ...deduped];
          });
          this.hasMore.set(res.hasMore);
          this.nextCursor.set(res.nextCursor);
          this.loadingMore.set(false);
        },
        error: () => {
          this.loadingMore.set(false);
          // Leave existing rows visible; the user can retry by clicking
          // "Load more" again. No snackbar — the button state is enough.
        },
      });
  }

  join(room: PublicRoomCatalogEntry): void {
    if (this.joiningIds().has(room.id)) return;
    this.markJoining(room.id, true);
    this.roomsService.join(room.id).subscribe({
      next: (detail) => {
        this.markJoining(room.id, false);
        // Flip this row in-place so the button becomes "Open" without needing
        // to refetch the whole page.
        this.rooms.update((list) =>
          list.map((r) =>
            r.id === room.id
              ? { ...r, isMember: true, memberCount: detail.memberCount }
              : r,
          ),
        );
        // Optimistic sidebar insert — `RoomsService` doesn't currently upsert
        // on join HTTP success (only via the `room:updated` socket), so push
        // the freshly-joined detail in manually. This keeps the sidebar in
        // sync before the user navigates.
        this.roomsService.upsertRoom(detail);
        this.router.navigate(['/chat', room.id]);
      },
      error: (err: HttpErrorResponse) => {
        this.markJoining(room.id, false);
        const msg =
          (typeof err.error?.error === 'string' && err.error.error) ||
          'Failed to join room. Please try again.';
        this.snackBar.open(msg, 'Dismiss', { duration: 5000 });
      },
    });
  }

  isJoining(roomId: string): boolean {
    return this.joiningIds().has(roomId);
  }

  trackById = (_index: number, room: PublicRoomCatalogEntry): string => room.id;

  private loadInitial(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.catalog
      .list({ q: this.searchControl.value, limit: PAGE_LIMIT })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.rooms.set(res.rooms);
          this.hasMore.set(res.hasMore);
          this.nextCursor.set(res.nextCursor);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.loadError.set(true);
        },
      });
  }

  private markJoining(id: string, busy: boolean): void {
    this.joiningIds.update((set) => {
      const next = new Set(set);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }
}
