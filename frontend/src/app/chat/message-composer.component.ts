import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  Output,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { CdkTextareaAutosize, TextFieldModule } from '@angular/cdk/text-field';
import { HttpErrorResponse } from '@angular/common/http';
import { filter, firstValueFrom, map } from 'rxjs';
import { MessagesService } from './messages.service';
import { UserBansService } from '../core/user-bans/user-bans.service';
import { AttachmentsService, UploadEvent } from '../core/attachments/attachments.service';
import type { Message, RoomDetail } from '@shared';

/** Max concurrent pending attachments per message (mirrors BE cap — contract D2). */
const MAX_ATTACHMENTS = 5;

/** Character cap on the reply-target preview rendered in the composer chip. */
const REPLY_PREVIEW_MAX = 80;

/**
 * Local-only state for a single pending attachment while the user is composing.
 * Stored on a signal array so template bindings stay reactive; the signal is
 * re-set (not mutated in place) whenever an entry's state changes.
 */
interface PendingAttachment {
  localId: string;
  file: File;
  previewObjectUrl: string | null;
  uploadProgress: number;
  uploadError: string | null;
  serverAttachmentId: string | null;
  commentControl: FormControl<string>;
}

@Component({
  selector: 'app-message-composer',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatProgressBarModule,
    MatTooltipModule,
    MatSnackBarModule,
    TextFieldModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './message-composer.component.html',
  styleUrl: './message-composer.component.scss',
  host: {
    '[class.composer--drag-active]': 'dragActive()',
  },
})
export class MessageComposerComponent {
  private readonly fb = inject(FormBuilder);
  private readonly messagesService = inject(MessagesService);
  private readonly userBansService = inject(UserBansService);
  private readonly attachmentsService = inject(AttachmentsService);
  private readonly snackBar = inject(MatSnackBar);

  readonly MAX_ATTACHMENTS = MAX_ATTACHMENTS;

  /**
   * The full `RoomDetail` is passed in (instead of `roomId`) so the composer
   * can freeze itself when the room is a banned DM without a second service
   * lookup. Stored on an internal signal so `isFrozen` is reactive.
   */
  private readonly roomSignal = signal<RoomDetail | null>(null);
  readonly room = this.roomSignal.asReadonly();

  @Input({ required: true })
  set roomDetail(value: RoomDetail) {
    this.roomSignal.set(value);
    this.serverError.set(null);
    // Swapping rooms mid-compose is an edge case; clear the queue so we don't
    // submit a file uploaded against the previous `roomId`.
    this.clearPending();
  }

  /**
   * Reply target lifted to the parent (`RoomViewComponent`). The composer
   * renders a chip above the textarea when present and forwards the id on
   * `message:send`. Mirrored into a signal so derivations recompute.
   */
  private readonly replyTargetSignal = signal<Message | null>(null);
  readonly replyTargetView = this.replyTargetSignal.asReadonly();

  @Input() set replyTarget(value: Message | null) {
    this.replyTargetSignal.set(value);
    // Refocus the textarea when the parent pushes a new reply target so the
    // user can start typing without an extra click.
    if (value) {
      queueMicrotask(() => this.textarea?.nativeElement.focus());
    }
  }

  /**
   * Emitted when the server acks a sent message. The parent (`RoomViewComponent`)
   * forwards this to `MessageListComponent.appendMessage()` so the sender's
   * own message shows up immediately (the server broadcast excludes the sender).
   */
  @Output() readonly messageSent = new EventEmitter<Message>();

  /**
   * Emitted when the user clicks the × on the reply chip, when the composer
   * auto-clears the chip after a successful send, or when the server rejects
   * the send with `'Invalid reply target'`. Parent owns the state.
   */
  @Output() readonly replyTargetCleared = new EventEmitter<void>();

  @ViewChild('textarea') textarea?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('autosize') autosize?: CdkTextareaAutosize;
  @ViewChild('fileInput') fileInput?: ElementRef<HTMLInputElement>;

  readonly submitting = signal(false);
  readonly serverError = signal<string | null>(null);
  readonly pendingAttachments = signal<PendingAttachment[]>([]);
  readonly dragActive = signal(false);

  readonly isFrozen = computed(() => {
    const r = this.roomSignal();
    if (!r || r.type !== 'dm' || !r.dmPeer) return false;
    return this.userBansService.isBanned(r.dmPeer.userId);
  });

  /** Display-ready truncated preview for the reply chip. */
  readonly replyPreview = computed(() => {
    const t = this.replyTargetSignal();
    if (!t) return null;
    const raw = (t.body ?? '').trim();
    const truncated =
      raw.length > REPLY_PREVIEW_MAX ? `${raw.slice(0, REPLY_PREVIEW_MAX)}…` : raw;
    return { username: t.username, body: truncated };
  });

  /** `true` while any pending chip has finished-uploading without an error. */
  readonly hasUploadedAttachments = computed(() =>
    this.pendingAttachments().some((a) => a.serverAttachmentId !== null && !a.uploadError),
  );

  /** `true` if any chip ended in an error — the user must remove it to send. */
  readonly hasUploadErrors = computed(() =>
    this.pendingAttachments().some((a) => a.uploadError !== null),
  );

  /** Attach button / DND / paste all off when send is in flight or room is frozen or at cap. */
  readonly attachDisabled = computed(
    () =>
      this.pendingAttachments().length >= MAX_ATTACHMENTS ||
      this.isFrozen() ||
      this.submitting(),
  );

  // No `required` validator — an empty composer is a neutral state, not an
  // error. The `onSubmit` flow rejects whitespace-only submissions without
  // at least one successfully-uploaded attachment.
  readonly form = this.fb.group({
    body: this.fb.control('', [Validators.maxLength(3072)]),
  });

  @HostListener('dragover', ['$event'])
  onDragOver(ev: DragEvent): void {
    if (this.isFrozen()) return;
    // Only highlight for file drags — ignore text/selection drags.
    if (!ev.dataTransfer) return;
    const types = ev.dataTransfer.types;
    if (!types || !Array.from(types).includes('Files')) return;
    ev.preventDefault();
    this.dragActive.set(true);
  }

  @HostListener('dragleave', ['$event'])
  onDragLeave(ev: DragEvent): void {
    // Only clear the highlight when the pointer leaves the composer entirely.
    // dragleave fires for every child element transition, so use relatedTarget.
    if (ev.relatedTarget && (ev.currentTarget as HTMLElement).contains(ev.relatedTarget as Node)) {
      return;
    }
    this.dragActive.set(false);
  }

  @HostListener('drop', ['$event'])
  onDrop(ev: DragEvent): void {
    this.dragActive.set(false);
    if (this.isFrozen()) return;
    if (!ev.dataTransfer || !ev.dataTransfer.files?.length) return;
    ev.preventDefault();
    this.enqueueFiles(Array.from(ev.dataTransfer.files));
  }

  onKeydown(event: KeyboardEvent): void {
    if (this.isFrozen()) {
      event.preventDefault();
      return;
    }
    // Shift+Enter → newline (browser default). Enter alone → submit.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.onSubmit();
    }
  }

  onPaste(event: ClipboardEvent): void {
    if (this.isFrozen()) return;
    const items = event.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length) {
      // Only swallow the native paste if we actually captured files — plain
      // text pastes flow through untouched.
      event.preventDefault();
      this.enqueueFiles(files);
    }
  }

  onFilesPicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (files && files.length) {
      this.enqueueFiles(Array.from(files));
    }
    // Reset so the same file can be re-picked later (Chrome doesn't re-fire
    // `change` for an unchanged path otherwise).
    input.value = '';
  }

  triggerFilePicker(): void {
    if (this.attachDisabled()) return;
    this.fileInput?.nativeElement.click();
  }

  removePending(localId: string): void {
    this.pendingAttachments.update((list) => {
      const entry = list.find((a) => a.localId === localId);
      if (entry?.previewObjectUrl) URL.revokeObjectURL(entry.previewObjectUrl);
      return list.filter((a) => a.localId !== localId);
    });
  }

  clearReplyTarget(): void {
    this.replyTargetCleared.emit();
  }

  trackByLocalId = (_i: number, a: PendingAttachment): string => a.localId;

  onSubmit(): void {
    if (this.submitting()) return;
    if (this.isFrozen()) return;
    if (this.hasUploadErrors()) return;

    const currentRoom = this.roomSignal();
    if (!currentRoom) return;

    const raw = this.form.controls.body.value ?? '';
    const trimmed = raw.trim();
    const pending = this.pendingAttachments();

    // Attachment-only messages are valid (contract: body.trim >= 1 OR attachmentIds >= 1).
    // Reject purely empty submissions silently.
    if (trimmed.length === 0 && pending.length === 0) {
      this.form.controls.body.markAsTouched();
      return;
    }

    // Validate every comment field up front — maxLength(200) is the contract cap.
    for (const entry of pending) {
      if (entry.commentControl.invalid) {
        entry.commentControl.markAsTouched();
        return;
      }
    }

    this.submitting.set(true);
    this.serverError.set(null);
    this.form.controls.body.disable({ emitEvent: false });

    void this.runSubmit(currentRoom.id, trimmed);
  }

  private async runSubmit(roomId: string, body: string): Promise<void> {
    const currentRoom = this.roomSignal();
    const replyToId = this.replyTargetSignal()?.id;
    try {
      const uploadedIds = await this.uploadAll(roomId);
      // If an upload just errored out, `uploadAll` throws below; otherwise
      // `uploadedIds` holds one id per pending entry in original order.
      const sendOptions: { attachmentIds?: string[]; replyToId?: string } = {};
      if (uploadedIds.length) sendOptions.attachmentIds = uploadedIds;
      if (replyToId) sendOptions.replyToId = replyToId;
      const message = await firstValueFrom(
        this.messagesService.send(
          roomId,
          body,
          Object.keys(sendOptions).length ? sendOptions : undefined,
        ),
      );
      this.messageSent.emit(message);
      // Clear the lifted reply target on success so the next send starts fresh.
      if (replyToId) this.replyTargetCleared.emit();
      this.resetComposerAfterSend();
    } catch (err) {
      this.submitting.set(false);
      this.form.controls.body.enable({ emitEvent: false });

      if (err instanceof HttpErrorResponse) {
        // Upload-side failure. Chip-level error text is already set by
        // `uploadOne`; surface the first human-readable message on the
        // composer's server-error line too.
        const first = this.pendingAttachments().find((a) => a.uploadError)?.uploadError;
        this.serverError.set(first ?? 'Attachment upload failed. Please try again.');
        if (err.status === 403 && this.isBlockedString(err)) {
          this.markIncomingBanIfDm(currentRoom);
        }
        return;
      }

      const msg = (err as Error)?.message || 'Failed to send message. Please try again.';
      this.serverError.set(msg);
      if (msg === 'Invalid attachment reference') {
        // Server rejected at `message:send` time (orphan sweep / cross-room
        // drift). Clear the rail so the user starts fresh.
        this.clearPending();
        this.serverError.set('Attachments expired; please re-attach.');
      } else if (msg === 'Invalid reply target') {
        // Server rejected because the reply target is gone (deleted) or
        // cross-room. Surface a snackbar + clear the reply chip so the user
        // can retry as a plain message.
        this.snackBar.open(
          'The message you were replying to is no longer available.',
          'Dismiss',
          { duration: 5000 },
        );
        this.serverError.set(null);
        this.replyTargetCleared.emit();
      } else if (msg === 'Personal messaging is blocked') {
        this.markIncomingBanIfDm(currentRoom);
      }
      // Don't clear the typed text — let the user edit and retry.
      this.form.controls.body.markAsTouched();
    }
  }

  /** Sequentially upload every pending attachment; populate `serverAttachmentId` as we go. */
  private async uploadAll(roomId: string): Promise<string[]> {
    const ids: string[] = [];
    for (const entry of this.pendingAttachments()) {
      if (entry.serverAttachmentId !== null) {
        // Already uploaded on a prior (failed) submit — reuse the id.
        ids.push(entry.serverAttachmentId);
        continue;
      }
      const id = await this.uploadOne(entry, roomId);
      ids.push(id);
    }
    return ids;
  }

  private async uploadOne(entry: PendingAttachment, roomId: string): Promise<string> {
    this.patchPending(entry.localId, { uploadProgress: 0, uploadError: null });
    const comment = entry.commentControl.value.trim();
    const payload = comment.length > 0 ? comment : null;
    try {
      const attachment = await firstValueFrom(
        this.attachmentsService.upload(entry.file, roomId, payload).pipe(
          // Stream progress into the chip; filter down to the final event.
          map((ev) => {
            if (ev.kind === 'progress') {
              this.patchPending(entry.localId, { uploadProgress: ev.progress });
            }
            return ev;
          }),
          filter((ev): ev is Extract<UploadEvent, { kind: 'final' }> => ev.kind === 'final'),
          map((ev) => ev.attachment),
        ),
      );
      this.patchPending(entry.localId, {
        uploadProgress: 1,
        serverAttachmentId: attachment.id,
      });
      return attachment.id;
    } catch (err) {
      const message = this.mapUploadError(err);
      this.patchPending(entry.localId, { uploadError: message });
      throw err;
    }
  }

  private mapUploadError(err: unknown): string {
    if (err instanceof HttpErrorResponse) {
      if (err.status === 413) return 'File too large';
      const body = err.error as { error?: string } | null;
      const serverMsg = typeof body?.error === 'string' ? body.error : '';
      if (err.status === 400) {
        if (serverMsg === 'Unsupported file type') return "This file type isn't supported";
        if (serverMsg === 'File content does not match declared type') {
          return "File content doesn't match its type";
        }
        return serverMsg || 'Upload rejected';
      }
      if (err.status === 403) {
        if (serverMsg === 'Personal messaging is blocked') {
          return 'Personal messaging is blocked';
        }
        return 'You do not have access to this room';
      }
      if (err.status === 404) return 'Room not found';
      return 'Upload failed';
    }
    return 'Upload failed';
  }

  private isBlockedString(err: HttpErrorResponse): boolean {
    const body = err.error as { error?: string } | null;
    return body?.error === 'Personal messaging is blocked';
  }

  private markIncomingBanIfDm(room: RoomDetail | null): void {
    if (room && room.type === 'dm' && room.dmPeer) {
      this.userBansService.markIncoming(room.dmPeer.userId);
    }
  }

  private enqueueFiles(incoming: File[]): void {
    if (this.isFrozen()) return;
    if (incoming.length === 0) return;

    const current = this.pendingAttachments();
    const remaining = MAX_ATTACHMENTS - current.length;
    if (remaining <= 0) {
      this.snackBar.open(
        `You can attach at most ${MAX_ATTACHMENTS} files per message`,
        'Dismiss',
        { duration: 5000 },
      );
      return;
    }

    const accepted = incoming.slice(0, remaining);
    const dropped = incoming.length - accepted.length;
    if (dropped > 0) {
      this.snackBar.open(
        `You can attach at most ${MAX_ATTACHMENTS} files per message`,
        'Dismiss',
        { duration: 5000 },
      );
    }

    const additions: PendingAttachment[] = accepted.map((file) => ({
      localId: this.generateLocalId(),
      file,
      previewObjectUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      uploadProgress: 0,
      uploadError: null,
      serverAttachmentId: null,
      commentControl: this.fb.nonNullable.control('', [Validators.maxLength(200)]),
    }));

    this.pendingAttachments.update((list) => [...list, ...additions]);
  }

  private patchPending(localId: string, patch: Partial<PendingAttachment>): void {
    this.pendingAttachments.update((list) =>
      list.map((a) => (a.localId === localId ? { ...a, ...patch } : a)),
    );
  }

  private resetComposerAfterSend(): void {
    // Revoke every local-preview object URL we minted — we never need them again.
    for (const entry of this.pendingAttachments()) {
      if (entry.previewObjectUrl) URL.revokeObjectURL(entry.previewObjectUrl);
    }
    this.pendingAttachments.set([]);
    this.form.controls.body.enable({ emitEvent: false });
    this.form.controls.body.setValue('', { emitEvent: false });
    this.form.controls.body.markAsUntouched();
    this.form.controls.body.markAsPristine();
    this.submitting.set(false);
    this.serverError.set(null);
    // Collapse the textarea back to a single row after a send.
    this.autosize?.reset();
    // Restore focus for rapid follow-ups.
    queueMicrotask(() => this.textarea?.nativeElement.focus());
  }

  private clearPending(): void {
    for (const entry of this.pendingAttachments()) {
      if (entry.previewObjectUrl) URL.revokeObjectURL(entry.previewObjectUrl);
    }
    this.pendingAttachments.set([]);
  }

  private generateLocalId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }
    // Fallback for older browsers — never exposed externally, so any unique
    // token is fine.
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
