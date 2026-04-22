import {
  AfterViewChecked,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnInit,
  Output,
  QueryList,
  SimpleChanges,
  ViewChild,
  ViewChildren,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { CdkTextareaAutosize, TextFieldModule } from '@angular/cdk/text-field';
import { MessagesService } from './messages.service';
import { MessageAttachmentComponent } from './message-attachment.component';
import { MessageDeleteDialogComponent } from './message-delete-dialog.component';
import { AuthService } from '../core/auth/auth.service';
import { UserBansService } from '../core/user-bans/user-bans.service';
import type { Message, RoomDetail } from '@shared';

/** Distance-from-bottom (rem) inside which we auto-scroll on new messages. */
const STICK_TO_BOTTOM_THRESHOLD_REM = 5; // ~80 px at 16 px root

/** Distance-from-top (rem) that triggers the paginate-up fetch. */
const LOAD_MORE_TRIGGER_REM = 4;

/** Max body length for an edited message (mirrors contract `EditMessageRequest`). */
const EDIT_BODY_MAX = 3072;

@Component({
  selector: 'app-message-list',
  standalone: true,
  imports: [
    DatePipe,
    ReactiveFormsModule,
    MatProgressSpinnerModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatFormFieldModule,
    MatInputModule,
    MatSnackBarModule,
    TextFieldModule,
    MessageAttachmentComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './message-list.component.html',
  styleUrl: './message-list.component.scss',
})
export class MessageListComponent implements OnInit, OnChanges, AfterViewChecked {
  private readonly messagesService = inject(MessagesService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly authService = inject(AuthService);
  private readonly userBansService = inject(UserBansService);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);

  @Input({ required: true }) roomId!: string;
  /**
   * Optional room detail — the parent `RoomViewComponent` passes it so the
   * list can derive the "DM is frozen" gate that hides the hover toolbar.
   * Kept as a plain Input (not signal) for wire-up symmetry with
   * `message-composer`'s `roomDetail` setter; the component reads it via the
   * `roomSignal` mirror below so `isDmFrozen` is reactive.
   */
  @Input() set roomDetail(value: RoomDetail | null | undefined) {
    this.roomSignal.set(value ?? null);
  }

  /** Emitted when the user clicks Reply on a message row. Parent lifts state. */
  @Output() readonly replyRequested = new EventEmitter<Message>();

  @ViewChild('scrollContainer') scrollContainer?: ElementRef<HTMLElement>;
  @ViewChildren('editTextarea') editTextareas?: QueryList<ElementRef<HTMLTextAreaElement>>;

  readonly messages = signal<Message[]>([]);
  readonly loading = signal(true);
  readonly loadError = signal(false);

  /** True when older pages exist server-side (driven by `hasMore` in responses). */
  readonly hasMore = signal(false);
  /** True while a paginate-up fetch is in flight. */
  readonly loadingMore = signal(false);
  /** True when the most recent paginate-up fetch failed; flips back to false on retry. */
  readonly loadMoreError = signal(false);

  /** When non-null, the row whose id matches renders in inline edit mode. */
  readonly editingMessageId = signal<string | null>(null);
  /** True while a PATCH is in flight for the currently-editing row. */
  readonly editSaving = signal(false);
  /** Shared control across all edit sessions; `setValue` is called on entry. */
  readonly editControl = new FormControl('', {
    nonNullable: true,
    validators: [Validators.maxLength(EDIT_BODY_MAX)],
  });

  /** Flag: on the next render we should scroll to the bottom. */
  private pendingScrollToBottom = false;
  /** Snapshot of scroll state captured right before an append. */
  private wasAtBottomBeforeAppend = true;

  /** Flag: the next view check should restore the scroll anchor after a prepend. */
  private pendingAnchorRestore = false;
  /** `scrollHeight` captured immediately before the prepend. */
  private capturedScrollHeight = 0;
  /** `scrollTop` captured immediately before the prepend. */
  private capturedScrollTop = 0;

  /** Set when the template should focus the edit textarea on next check. */
  private pendingEditFocus = false;

  /**
   * Internal mirror of the `roomDetail` input. Signals feed `isDmFrozen`'s
   * reactivity without the parent needing to push a signal across the
   * component boundary.
   */
  private readonly roomSignal = signal<RoomDetail | null>(null);

  readonly currentUserId = computed(() => this.authService.currentUser()?.id ?? null);

  /**
   * Hover toolbar is hidden entirely when the open room is a frozen DM
   * (either side has blocked). Mirrors the `isFrozen` derivation in
   * `MessageComposerComponent` — reuses `UserBansService.isBanned` as the
   * single source of truth.
   */
  readonly isDmFrozen = computed(() => {
    const r = this.roomSignal();
    if (!r || r.type !== 'dm' || !r.dmPeer) return false;
    return this.userBansService.isBanned(r.dmPeer.userId);
  });

  ngOnInit(): void {
    this.loadInitial();
    this.subscribeToNewMessages();
    this.subscribeToEditedMessages();
    this.subscribeToDeletedMessages();
  }

  ngOnChanges(changes: SimpleChanges): void {
    // If the host swaps `roomId` while the component is kept alive, refresh.
    if (changes['roomId'] && !changes['roomId'].firstChange) {
      this.resetPaginationState();
      this.loadInitial();
      // Re-subscribe not needed: newMessages$ reads roomId at call time,
      // but we do need a new subscription because the filter is bound.
      this.subscribeToNewMessages();
    }
  }

  ngAfterViewChecked(): void {
    // Anchor-restore is a prepend-side operation; evaluate BEFORE the
    // bottom-pin drain. On the same tick only one can be set, but defensive
    // ordering keeps the intent explicit.
    if (this.pendingAnchorRestore && this.scrollContainer) {
      const el = this.scrollContainer.nativeElement;
      const delta = el.scrollHeight - this.capturedScrollHeight;
      el.scrollTop = this.capturedScrollTop + delta;
      this.pendingAnchorRestore = false;
    }
    if (this.pendingScrollToBottom && this.scrollContainer) {
      const el = this.scrollContainer.nativeElement;
      el.scrollTop = el.scrollHeight;
      this.pendingScrollToBottom = false;
    }
    if (this.pendingEditFocus) {
      // A QueryList filtered by the `@if editingMessageId() === m.id` branch
      // produces a single element at most; pick the first and focus it.
      const el = this.editTextareas?.first?.nativeElement;
      if (el) {
        el.focus();
        // Place caret at the end of the prefilled body.
        const pos = el.value.length;
        el.setSelectionRange(pos, pos);
        this.pendingEditFocus = false;
      }
    }
  }

  trackById = (_index: number, m: Message): string => m.id;

  canEditOrDelete(m: Message): boolean {
    return this.currentUserId() === m.userId && !this.isDmFrozen();
  }

  canReply(): boolean {
    return !this.isDmFrozen();
  }

  /**
   * Scroll handler on the message scroll container. Fires the paginate-up
   * fetch when the user is within `LOAD_MORE_TRIGGER_REM` of the top AND
   * there's more to load AND we're not already loading.
   */
  onScroll(): void {
    const el = this.scrollContainer?.nativeElement;
    if (!el) return;
    if (!this.hasMore() || this.loadingMore() || this.loadMoreError()) return;

    const rootFontSize =
      parseFloat(getComputedStyle(document.documentElement).fontSize || '16') || 16;
    const triggerPx = LOAD_MORE_TRIGGER_REM * rootFontSize;
    if (el.scrollTop < triggerPx) {
      this.loadMore();
    }
  }

  /**
   * Retry a failed paginate-up fetch. Called from the top-of-list error card.
   */
  retryLoadMore(): void {
    this.loadMoreError.set(false);
    this.loadMore();
  }

  /**
   * Appends a message. Invoked both from the socket stream and externally
   * from the composer when its ack resolves.
   */
  appendMessage(message: Message): void {
    if (message.roomId !== this.roomId) return;
    // Ignore duplicates — the server excludes sender, but if the composer
    // also appends its own ack result, dedupe by id.
    const current = this.messages();
    if (current.some((m) => m.id === message.id)) return;
    this.wasAtBottomBeforeAppend = this.isNearBottom();
    this.messages.update((list) => [...list, message]);
    if (this.wasAtBottomBeforeAppend) {
      this.pendingScrollToBottom = true;
    }
  }

  /**
   * Called from `MessageAttachmentComponent` when an inline image finishes
   * loading its byte stream. Images resolve async (via `blob:` URL), which
   * can change the rendered height of a message row AFTER the initial paint.
   * If the user was anchored to the bottom, re-pin to the bottom on the
   * next view check.
   *
   * Round 9: a scrolled-up user (reading older history) is NOT near-bottom,
   * so images inside a newly prepended page do NOT re-pin — the anchor-
   * preservation logic in `ngAfterViewChecked` keeps the visible message
   * glued in place as those heights settle.
   */
  onAttachmentLoaded(): void {
    if (this.isNearBottom()) {
      this.pendingScrollToBottom = true;
    }
  }

  onReplyClick(m: Message): void {
    if (!this.canReply()) return;
    this.replyRequested.emit(m);
  }

  onEditClick(m: Message): void {
    if (!this.canEditOrDelete(m)) return;
    this.editingMessageId.set(m.id);
    this.editControl.setValue(m.body);
    this.editControl.markAsPristine();
    this.editControl.markAsUntouched();
    this.editSaving.set(false);
    this.pendingEditFocus = true;
  }

  onEditCancel(): void {
    this.editingMessageId.set(null);
    this.editSaving.set(false);
  }

  onEditKeydown(event: KeyboardEvent): void {
    // Esc cancels; Ctrl/Cmd+Enter saves. Bare Enter inserts a newline — the
    // composer's submit-on-Enter convention is reversed here because edits
    // are a lower-frequency flow where accidental sends cost more.
    if (event.key === 'Escape') {
      event.preventDefault();
      this.onEditCancel();
      return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.onEditSave();
    }
  }

  onEditSave(): void {
    const id = this.editingMessageId();
    if (!id || this.editSaving()) return;
    const target = this.messages().find((m) => m.id === id);
    if (!target) {
      // Row was deleted mid-edit (via socket broadcast). Drop the edit.
      this.onEditCancel();
      return;
    }

    const raw = this.editControl.value ?? '';
    const trimmed = raw.trim();
    const hasAttachments = (target.attachments?.length ?? 0) > 0;

    // Contract: trimmed length 1..3072 OR empty-after-trim when the message
    // has at least one attachment (attachment-only bodies can be cleared).
    if (trimmed.length === 0 && !hasAttachments) {
      this.editControl.markAsTouched();
      return;
    }
    if (trimmed.length > EDIT_BODY_MAX) {
      this.editControl.markAsTouched();
      return;
    }
    if (trimmed === target.body) {
      // No-op edit — just close the editor without a network round-trip.
      this.onEditCancel();
      return;
    }

    this.editSaving.set(true);
    this.messagesService
      .edit(id, trimmed)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (updated) => {
          this.messages.update((list) => list.map((m) => (m.id === updated.id ? updated : m)));
          this.editSaving.set(false);
          this.editingMessageId.set(null);
        },
        error: (err: HttpErrorResponse | Error) => {
          this.editSaving.set(false);
          const msg = this.extractServerError(err, 'Failed to edit message. Please try again.');
          this.snackBar.open(msg, 'Dismiss', { duration: 5000 });
          // Keep edit mode open so the user can correct and retry.
        },
      });
  }

  onDeleteClick(m: Message): void {
    if (!this.canEditOrDelete(m)) return;
    this.dialog
      .open<MessageDeleteDialogComponent, void, boolean>(MessageDeleteDialogComponent, {
        width: '28rem',
        autoFocus: 'first-tabbable',
        restoreFocus: true,
      })
      .afterClosed()
      .subscribe((confirmed) => {
        if (!confirmed) return;
        this.messagesService
          .delete(m.id)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            next: () => {
              this.messages.update((list) => list.filter((x) => x.id !== m.id));
              // If we were editing this very row, close the editor.
              if (this.editingMessageId() === m.id) {
                this.editingMessageId.set(null);
              }
            },
            error: (err: HttpErrorResponse | Error) => {
              const msg = this.extractServerError(
                err,
                'Failed to delete message. Please try again.',
              );
              this.snackBar.open(msg, 'Dismiss', { duration: 5000 });
            },
          });
      });
  }

  /**
   * Smooth-scroll to the target message if it's currently loaded. If the
   * reply target is not in the window (user hasn't paginated back far
   * enough), this is a no-op — autoload of older pages to surface a reply
   * target is a Round-10 Config-improvement item.
   */
  scrollToMessage(messageId: string): void {
    const container = this.scrollContainer?.nativeElement;
    if (!container) return;
    const target = container.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(messageId)}"]`,
    );
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  private loadInitial(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.messagesService
      .getHistory(this.roomId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.messages.set(res.messages);
          this.hasMore.set(res.hasMore);
          this.loading.set(false);
          // Always scroll to bottom on first paint.
          this.pendingScrollToBottom = true;
        },
        error: () => {
          this.loading.set(false);
          this.loadError.set(true);
        },
      });
  }

  private loadMore(): void {
    const el = this.scrollContainer?.nativeElement;
    if (!el) return;
    const current = this.messages();
    if (current.length === 0) return; // nothing to anchor on

    this.loadingMore.set(true);
    this.capturedScrollHeight = el.scrollHeight;
    this.capturedScrollTop = el.scrollTop;
    this.pendingAnchorRestore = true;

    const cursorId = current[0].id;
    this.messagesService
      .getHistory(this.roomId, { before: cursorId })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          // Defensive: if the user swapped rooms / reloaded mid-flight, the
          // cursor we requested is no longer in the list — drop the response
          // so we don't prepend stale data to a different room's thread.
          if (!this.messages().some((m) => m.id === cursorId)) {
            this.loadingMore.set(false);
            this.pendingAnchorRestore = false;
            return;
          }
          const existingIds = new Set(this.messages().map((m) => m.id));
          const deduped = res.messages.filter((m) => !existingIds.has(m.id));
          this.messages.update((list) => [...deduped, ...list]);
          this.hasMore.set(res.hasMore);
          this.loadingMore.set(false);
        },
        error: () => {
          this.loadingMore.set(false);
          this.loadMoreError.set(true);
          this.pendingAnchorRestore = false; // nothing new to restore against
        },
      });
  }

  private resetPaginationState(): void {
    this.messages.set([]);
    this.hasMore.set(false);
    this.loadingMore.set(false);
    this.loadMoreError.set(false);
    this.pendingAnchorRestore = false;
    this.capturedScrollHeight = 0;
    this.capturedScrollTop = 0;
    // Room swap mid-edit: drop the editor so the next room doesn't open
    // with a stale edit flag pointing at an id that no longer exists.
    this.editingMessageId.set(null);
    this.editSaving.set(false);
  }

  private subscribeToNewMessages(): void {
    this.messagesService
      .newMessages$(this.roomId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((message) => {
        this.appendMessage(message);
      });
  }

  private subscribeToEditedMessages(): void {
    this.messagesService
      .editedMessages$()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((updated) => {
        if (updated.roomId !== this.roomId) return;
        this.messages.update((list) =>
          list.map((m) => (m.id === updated.id ? updated : m)),
        );
      });
  }

  private subscribeToDeletedMessages(): void {
    this.messagesService
      .deletedMessages$()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((payload) => {
        if (payload.roomId !== this.roomId) return;
        this.messages.update((list) => list.filter((m) => m.id !== payload.messageId));
        // If we had the now-deleted row open in an editor (e.g. another tab
        // of the same author deleted it), close the editor cleanly.
        if (this.editingMessageId() === payload.messageId) {
          this.editingMessageId.set(null);
          this.editSaving.set(false);
        }
      });
  }

  private extractServerError(err: HttpErrorResponse | Error, fallback: string): string {
    if (err instanceof HttpErrorResponse) {
      const body = err.error as { error?: string } | null;
      if (typeof body?.error === 'string' && body.error.length > 0) return body.error;
      return fallback;
    }
    return err?.message || fallback;
  }

  private isNearBottom(): boolean {
    const el = this.scrollContainer?.nativeElement;
    if (!el) return true;
    const rootFontSize =
      parseFloat(getComputedStyle(document.documentElement).fontSize || '16') || 16;
    const thresholdPx = STICK_TO_BOTTOM_THRESHOLD_REM * rootFontSize;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= thresholdPx;
  }

  /** Imported by the template to satisfy the non-null TextareaAutosize ref. */
  protected readonly CdkTextareaAutosize = CdkTextareaAutosize;
}
