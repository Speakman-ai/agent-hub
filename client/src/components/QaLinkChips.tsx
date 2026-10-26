import { SquareCheckBig, Target } from 'lucide-react';

export interface LinkProps {
  onOpenEpic?: (epicId: string) => void;
  onOpenCard?: (cardId: string) => void;
}

export function LinkChips({
  epic,
  card,
  onOpenEpic,
  onOpenCard,
}: {
  epic: { id: string; name: string } | null;
  card: { id: string; title: string } | null;
} & LinkProps) {
  if (!epic && !card) return null;
  const chip =
    'inline-flex max-w-[14rem] items-center gap-1 rounded-full border border-gray-700 bg-gray-800 px-2 py-0.5 text-[11px] text-gray-300 hover:border-gray-500';
  return (
    <span className="inline-flex flex-wrap gap-1">
      {epic && (
        <button
          type="button"
          className={chip}
          title={`Epic: ${epic.name}`}
          onClick={() => onOpenEpic?.(epic.id)}
          disabled={!onOpenEpic}
        >
          <Target size={11} className="flex-shrink-0" />
          <span className="truncate">{epic.name}</span>
        </button>
      )}
      {card && (
        <button
          type="button"
          className={chip}
          title={`Card: ${card.title}`}
          onClick={() => onOpenCard?.(card.id)}
          disabled={!onOpenCard}
        >
          <SquareCheckBig size={11} className="flex-shrink-0" />
          <span className="truncate">{card.title}</span>
        </button>
      )}
    </span>
  );
}
