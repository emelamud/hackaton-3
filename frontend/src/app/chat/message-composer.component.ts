import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  ViewChild,
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
import type { Message } from '../../../../shared/types';

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

  @Input({ required: true }) roomId!: string;

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

  // No `required` validator — an empty composer is a neutral state, not an
  // error. The `onSubmit` flow rejects whitespace-only submissions.
  readonly form = this.fb.group({
    body: this.fb.control('', [Validators.maxLength(3072)]),
  });

  onKeydown(event: KeyboardEvent): void {
    // Shift+Enter → newline (browser default). Enter alone → submit.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.onSubmit();
    }
  }

  onSubmit(): void {
    if (this.submitting()) return;

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

    this.messagesService.send(this.roomId, trimmed).subscribe({
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
        this.serverError.set(err?.message || 'Failed to send message. Please try again.');
        // Don't clear the typed text — let the user edit and retry.
        this.form.controls.body.markAsTouched();
      },
    });
  }
}
