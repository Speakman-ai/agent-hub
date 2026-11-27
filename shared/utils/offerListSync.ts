/**
 * Client-side open-offer list (web and mobile hooks share it), kept correct
 * across live events, action responses and list fetches that race each other.
 *
 * State is one entry per offer id holding the newest version seen (by server
 * `revision`), including offers no longer shown. Every input is a candidate
 * version: it replaces the entry only if its revision is higher, so no
 * ordering of events, responses and snapshots can put an older version back.
 * The visible list is derived: entries that are open and not hidden.
 *
 * A snapshot also answers "which offers are gone?": an entry missing from it
 * is hidden, unless that entry was updated after the fetch began (a newer
 * event the snapshot could not have included). Only the newest fetch's
 * snapshot is applied; an older one arriving late is dropped.
 */
import { sortOpenOffers, type ProactiveOffer } from './serverAgentProactive';

interface Entry {
  offer: ProactiveOffer;
  /** Local sequence of the last change, compared against fetch start. */
  at: number;
  /** Removed locally or absent from a snapshot, without a newer version. */
  hidden: boolean;
}

export class OfferListSync {
  private entries = new Map<string, Entry>();
  private clock = 0;
  private seq = 0;
  private appliedSeq = 0;
  /** Fetch token → local clock when it began. */
  private pending = new Map<number, number>();
  /** Kinds hidden by "Never for this kind" → local clock when hidden. */
  private hiddenKinds = new Map<ProactiveOffer['kind'], number>();

  constructor(private readonly onChange: (offers: ProactiveOffer[]) => void) {}

  current(): ProactiveOffer[] {
    return sortOpenOffers([...this.entries.values()].filter((e) => !e.hidden).map((e) => e.offer));
  }

  /** Call before starting a list fetch; pass the token to `snapshot`/`fail`. */
  beginFetch(): number {
    const token = ++this.seq;
    this.pending.set(token, this.clock);
    return token;
  }

  snapshot(token: number, offers: readonly ProactiveOffer[]): void {
    const startedAt = this.pending.get(token);
    this.pending.delete(token);
    if (startedAt === undefined || token < this.appliedSeq) return;
    this.appliedSeq = token;
    const listed = new Set<string>();
    for (const row of offers) {
      listed.add(row.id);
      const seen = this.entries.get(row.id);
      // Snapshot rows date from the fetch start, never "after" it.
      if (!seen || row.revision > seen.offer.revision) {
        // A kind the user hid after this fetch began stays hidden: the
        // snapshot predates the "Never" and can't overrule it.
        const hiddenAt = this.hiddenKinds.get(row.kind);
        const hidden = hiddenAt !== undefined && hiddenAt > startedAt;
        this.entries.set(row.id, { offer: row, at: startedAt, hidden });
      }
    }
    for (const [id, entry] of this.entries) {
      if (!listed.has(id) && entry.at <= startedAt) entry.hidden = true;
    }
    this.emit();
  }

  fail(token: number): void {
    this.pending.delete(token);
  }

  /** A live event or an action result for one offer. */
  update(
    event: { offer?: ProactiveOffer | null; offerId?: string | null } | null | undefined,
  ): void {
    const offer = event?.offer ?? null;
    if (!offer) return;
    const seen = this.entries.get(offer.id);
    if (seen && seen.offer.revision >= offer.revision) return;
    this.entries.set(offer.id, { offer, at: ++this.clock, hidden: false });
    this.emit();
  }

  /**
   * "Never for this kind": hide every offer of the kind seen so far. Each one
   * also gets its own suppressed broadcast with a higher revision; this only
   * hides them before those arrive. A newer open version can still show.
   */
  removeKind(kind: ProactiveOffer['kind']): void {
    const at = ++this.clock;
    this.hiddenKinds.set(kind, at);
    for (const entry of this.entries.values()) {
      if (entry.offer.kind === kind && !entry.hidden) {
        entry.hidden = true;
        entry.at = at;
      }
    }
    this.emit();
  }

  private emit(): void {
    this.onChange(this.current());
  }
}
