export declare const TOO_LARGE: 'too_large';

export declare function normalizeText(raw: string): string;
export declare function htmlToText(html: string): string;
export declare function declaredZipExpandedSize(buf: Buffer): number;

export interface ExtractDocumentInput {
  kind: 'text' | 'markdown' | 'html' | 'pdf' | 'docx';
  bytes: Buffer | Uint8Array;
  maxChars: number;
  maxPages: number;
  maxExpandedBytes: number;
}

export declare function extractDocumentText(
  input: ExtractDocumentInput,
): Promise<{ text: string; truncated: boolean }>;
