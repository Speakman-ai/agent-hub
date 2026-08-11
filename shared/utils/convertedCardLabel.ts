/**
 * Naming of the kanban card a support ticket was converted into or linked to.
 *
 * The ticket row only carries `converted_card_id`, an opaque uuid that matches
 * nothing an operator can see or search for on the board — cards are named
 * there by `#short_id` and title. Support surfaces render this label instead so
 * "converted" points at something findable.
 */

export interface ConvertedCardSummary {
  id: string;
  short_id?: number | null;
  title?: string | null;
  column_name?: string | null;
}

export interface TicketWithConvertedCard {
  converted_card?: ConvertedCardSummary | null;
  converted_card_id?: string | null;
}

/**
 * Board-facing label for a ticket's card, or null when the server could not
 * resolve one (unconverted ticket, deleted card, or a payload predating the
 * `converted_card` field). Callers fall back to plain "Converted to card".
 */
export function convertedCardLabel(
  ticket: TicketWithConvertedCard | null | undefined,
): string | null {
  const card = ticket?.converted_card;
  const title = typeof card?.title === 'string' ? card.title.trim() : '';
  if (!card?.id || !title) return null;
  const shortId =
    typeof card.short_id === 'number' && Number.isFinite(card.short_id) ? card.short_id : null;
  return shortId ? `#${shortId} · ${title}` : title;
}

/** The card id a support surface should open, or null when there is none. */
export function convertedCardId(ticket: TicketWithConvertedCard | null | undefined): string | null {
  const id = ticket?.converted_card?.id || ticket?.converted_card_id || null;
  return typeof id === 'string' && id.trim() ? id : null;
}
