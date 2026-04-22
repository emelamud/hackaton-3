export type AttachmentKind = 'image' | 'file';

export interface Attachment {
  id: string;
  roomId: string;
  uploaderId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: AttachmentKind;
  comment: string | null;
  createdAt: string;
}

export interface UploadAttachmentResponse {
  attachment: Attachment;
}
