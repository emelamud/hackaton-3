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
import { MessagesService } from './messages.service';
import type { Message } from '../../../../shared/types';

/** Distance-from-bottom (rem) inside which we auto-scroll on new messages. */
const STICK_TO_BOTTOM_THRESHOLD_REM = 5; // ~80 px at 16 px root

@Component({
  selector: 'app-message-list',
  standalone: true,
  imports: [DatePipe, MatProgressSpinnerModule, MatIconModule],
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

  /** Flag: on the next render we should scroll to the bottom. */
  private pendingScrollToBottom = false;
  /** Snapshot of scroll state captured right before an append. */
  private wasAtBottomBeforeAppend = true;

  ngOnInit(): void {
    this.loadRecent();
    this.subscribeToNewMessages();
  }

  ngOnChanges(changes: SimpleChanges): void {
    // If the host swaps `roomId` while the component is kept alive, refresh.
    if (changes['roomId'] && !changes['roomId'].firstChange) {
      this.messages.set([]);
      this.loadRecent();
      // Re-subscribe not needed: newMessages$ reads roomId at call time,
      // but we do need a new subscription because the filter is bound.
      this.subscribeToNewMessages();
    }
  }

  ngAfterViewChecked(): void {
    if (this.pendingScrollToBottom && this.scrollContainer) {
      const el = this.scrollContainer.nativeElement;
      el.scrollTop = el.scrollHeight;
      this.pendingScrollToBottom = false;
    }
  }

  trackById = (_index: number, m: Message): string => m.id;

  private loadRecent(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.messagesService
      .getRecent(this.roomId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (messages) => {
          this.messages.set(messages);
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

  private subscribeToNewMessages(): void {
    this.messagesService
      .newMessages$(this.roomId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((message) => {
        this.appendMessage(message);
      });
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

  private isNearBottom(): boolean {
    const el = this.scrollContainer?.nativeElement;
    if (!el) return true;
    const rootFontSize =
      parseFloat(getComputedStyle(document.documentElement).fontSize || '16') || 16;
    const thresholdPx = STICK_TO_BOTTOM_THRESHOLD_REM * rootFontSize;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= thresholdPx;
  }
}
