/** Within this many points of the bottom, a message list keeps following new messages. */
const FOLLOW_TAIL_SLOP = 80;

export function shouldFollowTail(offsetY: number, viewHeight: number, contentHeight: number) {
  return contentHeight - (offsetY + viewHeight) <= FOLLOW_TAIL_SLOP;
}
