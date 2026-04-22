import {
  AfterViewChecked,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Input,
  OnChanges,
  OnInit,
  SimpleChanges,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MessagesService } from './messages.service';
import { MessageAttachmentComponent } from './message-attachment.component';
import type { Message } from '@shared';

/** Distance-from-bottom (rem) inside which we auto-scroll on new messages. */
const STICK_TO_BOTTOM_THRESHOLD_REM = 5; // ~80 px at 16 px root

/** Distance-from-top (rem) that triggers the paginate-up fetch. */
const LOAD_MORE_TRIGGER_REM = 4;

@Component({
  selector: 'app-message-list',
  standalone: true,
  imports: [
    DatePipe,
    MatProgressSpinnerModule,
    MatIconModule,
    MatButtonModule,
    MessageAttachmentComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './message-list.component.html',
  styleUrl: './message-list.component.scss',
})
export class MessageListComponent implements OnInit, OnChanges, AfterViewChecked {
  private readonly messagesService = inject(MessagesService);
  private readonly destroyRef = inject(DestroyRef);

  @Input({ required: true }) roomId!: string;

  @ViewChild('scrollContainer') scrollContainer?: ElementRef<HTMLElement>;

  readonly messages = signal<Message[]>([]);
  readonly loading = signal(true);
  readonly loadError = signal(false);

  /** True when older pages exist server-side (driven by `hasMore` in responses). */
  readonly hasMore = signal(false);
  /** True while a paginate-up fetch is in flight. */
  readonly loadingMore = signal(false);
  /** True when the most recent paginate-up fetch failed; flips back to false on retry. */
  readonly loadMoreError = signal(false);

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

  ngOnInit(): void {
    this.loadInitial();
    this.subscribeToNewMessages();
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
  }

  trackById = (_index: number, m: Message): string => m.id;

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
  }

  private subscribeToNewMessages(): void {
    this.messagesService
      .newMessages$(this.roomId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((message) => {
        this.appendMessage(message);
      });
  }

  private isNearBottom(): boolean {
    const el = this.scrollContainer?.nativeElement;
    if (!el) return true;
    const rootFontSize =
      parseFloat(getComputedStyle(document.documentElement).fontSize || '16') || 16;
    const thresholdPx = STICK_TO_BOTTOM_THRESHOLD_REM * rootFontSize;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= thresholdPx;
  }
}
