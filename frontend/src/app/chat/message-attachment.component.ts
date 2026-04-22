import { ChangeDetectionStrategy, Component, EventEmitter, Output, computed, inject, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { AttachmentsService } from '../core/attachments/attachments.service';
import type { Attachment } from '@shared';

/**
 * Renders a single attachment inside a message row.
 *
 * `kind === 'image'` → inline `<img>` inside an `<a target="_blank">` so the
 * caller can open the full-size image in a new tab. The `<img src>` is bound
 * to a `blob:` URL signal owned by `AttachmentsService`, so the first render
 * paints a lightweight placeholder while the byte fetch is in flight.
 *
 * `kind === 'file'` → `mat-stroked-button` rendered as `<a [download]>` with
 * the original filename + a human-readable size. Clicking the card drives a
 * browser download via the `Content-Disposition: attachment` header the BE
 * sets on non-image attachments.
 *
 * Zero `innerHTML`, zero `bypassSecurityTrust*` — all string interpolation
 * flows through Angular's default sanitization.
 */
@Component({
  selector: 'app-message-attachment',
  standalone: true,
  imports: [MatIconModule, MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './message-attachment.component.html',
  styleUrl: './message-attachment.component.scss',
})
export class MessageAttachmentComponent {
  private readonly attachmentsService = inject(AttachmentsService);

  /** The committed attachment row to render. */
  readonly att = input.required<Attachment>();

  /**
   * Emitted whenever an inline image finishes loading its byte stream. The
   * parent `MessageListComponent` subscribes so the scroll-to-bottom heuristic
   * can re-run — without this, a recent image can change its rendered height
   * after the initial render and push the user off the bottom anchor.
   */
  @Output() readonly loaded = new EventEmitter<void>();

  /** Memoised signal handle — avoids calling `objectUrlFor` on every CD cycle. */
  private readonly urlSignal = computed(() => this.attachmentsService.objectUrlFor(this.att().id));

  /** Current `blob:` URL or `null` while the fetch is in flight. */
  readonly objectUrl = computed(() => this.urlSignal()());

  /** Display-ready human readable size ("142.4 KB"). */
  readonly formattedSize = computed(() => this.formatSize(this.att().sizeBytes));

  onImageLoad(): void {
    this.loaded.emit();
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
