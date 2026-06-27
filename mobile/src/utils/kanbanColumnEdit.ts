export type KanbanColumnEditPayload = {
  name: string;
  color: string;
};

export function buildKanbanColumnEditPayload({
  currentName,
  nextName,
  color,
  locked,
}: {
  currentName: string;
  nextName: string;
  color: string;
  locked: boolean;
}): KanbanColumnEditPayload {
  return {
    name: locked ? currentName : nextName.trim(),
    color,
  };
}
