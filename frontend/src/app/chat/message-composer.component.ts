import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { CdkTextareaAutosize, TextFieldModule } from '@angular/cdk/text-field';
import { MessagesService } from './messages.service';
import { UserBansService } from '../core/user-bans/user-bans.service';
import type { Message, RoomDetail } from '@shared';

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
    TextFieldModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './message-composer.component.html',
  styleUrl: './message-composer.component.scss',
})
export class MessageComposerComponent {
  private readonly fb = inject(FormBuilder);
  private readonly messagesService = inject(MessagesService);
  private readonly userBansService = inject(UserBansService);

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
  }

  /**
   * Emitted when the server acks a sent message. The parent (`RoomViewComponent`)
   * forwards this to `MessageListComponent.appendMessage()` so the sender's
   * own message shows up immediately (the server broadcast excludes the sender).
   */
  @Output() readonly messageSent = new EventEmitter<Message>();

  @ViewChild('textarea') textarea?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('autosize') autosize?: CdkTextareaAutosize;

  readonly submitting = signal(false);
  readonly serverError = signal<string | null>(null);

  readonly isFrozen = computed(() => {
    const r = this.roomSignal();
    if (!r || r.type !== 'dm' || !r.dmPeer) return false;
    return this.userBansService.isBanned(r.dmPeer.userId);
  });

  // No `required` validator — an empty composer is a neutral state, not an
  // error. The `onSubmit` flow rejects whitespace-only submissions.
  readonly form = this.fb.group({
    body: this.fb.control('', [Validators.maxLength(3072)]),
  });

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

  onSubmit(): void {
    if (this.submitting()) return;
    if (this.isFrozen()) return;

    const currentRoom = this.roomSignal();
    if (!currentRoom) return;

    const raw = this.form.controls.body.value ?? '';
    const trimmed = raw.trim();

    if (trimmed.length === 0) {
      // Reject empty / whitespace-only submissions silently — don't nag the user.
      this.form.controls.body.markAsTouched();
      return;
    }

    this.submitting.set(true);
    this.serverError.set(null);
    this.form.controls.body.disable({ emitEvent: false });

    this.messagesService.send(currentRoom.id, trimmed).subscribe({
      next: (message) => {
        this.messageSent.emit(message);
        this.form.controls.body.enable({ emitEvent: false });
        this.form.controls.body.setValue('', { emitEvent: false });
        this.form.controls.body.markAsUntouched();
        this.form.controls.body.markAsPristine();
        this.submitting.set(false);
        // Collapse the textarea back to a single row after a send.
        this.autosize?.reset();
        // Restore focus for rapid follow-ups.
        queueMicrotask(() => this.textarea?.nativeElement.focus());
      },
      error: (err: Error) => {
        this.submitting.set(false);
        this.form.controls.body.enable({ emitEvent: false });
        const msg = err?.message || 'Failed to send message. Please try again.';
        this.serverError.set(msg);
        // Race: the peer banned us mid-type. Freeze the composer retroactively
        // by marking the peer as incoming-banned locally. The next render
        // collapses the form into the frozen banner.
        if (
          msg === 'Personal messaging is blocked' &&
          currentRoom.type === 'dm' &&
          currentRoom.dmPeer
        ) {
          this.userBansService.markIncoming(currentRoom.dmPeer.userId);
        }
        // Don't clear the typed text — let the user edit and retry.
        this.form.controls.body.markAsTouched();
      },
    });
  }
}
