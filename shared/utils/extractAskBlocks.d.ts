export interface AskExtractionResult {
  strippedText: string;
  asks: unknown[];
}

export function extractAskBlocks(
  text: string,
  options?: { lockedBodies?: Array<{ start: number; end: number }> },
): AskExtractionResult;

export function parseAskPayload(raw: string): unknown;
