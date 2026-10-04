import type { Dot, DotRank } from "./types";

export const RANK_OPTIONS: { rank: DotRank; label: string; hint: string }[] = [
  { rank: 2, label: "Primary", hint: "Largest, shown first" },
  { rank: 1, label: "Standard", hint: "Default size" },
  { rank: 0, label: "Quiet", hint: "Smaller, shown last" },
];

export function dotRank(dot: { rank?: number }): DotRank {
  return dot.rank === 0 || dot.rank === 2 ? dot.rank : 1;
}

/** Primary dots first, then standard, then quiet. Ties keep creation order. */
export function byImportance(a: Dot, b: Dot) {
  return dotRank(b) - dotRank(a) || a.createdAt - b.createdAt;
}
