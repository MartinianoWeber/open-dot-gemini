"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { setDotRank } from "@/app/actions";
import { markRead } from "@/lib/store";
import { byImportance, dotRank, RANK_OPTIONS } from "@/lib/rank";
import { statusDot } from "@/lib/status";
import DotOrb from "./DotOrb";
import type { Dot, DotRank } from "@/lib/types";

const ORB: Record<DotRank, number> = { 0: 28, 1: 40, 2: 54 };
const SLOT: Record<DotRank, string> = { 0: "w-[48px]", 1: "w-[60px]", 2: "w-[74px]" };
const LABEL: Record<DotRank, string> = { 0: "text-[10px]", 1: "text-[11px]", 2: "text-[12px] font-medium" };

type Menu = { id: string; x: number; y: number };

/**
 * Horizontal picker for many dots. The row is width-constrained so it actually
 * scrolls (wheel, drag, and the edge buttons). Primary dots are larger and come first.
 */
export default function DotRail({
  dots,
  activeId,
  onSelect,
  showNew = false,
  fade = "background",
  className = "",
}: {
  dots: Dot[];
  activeId?: string | null;
  /** When set, picking a dot calls this instead of opening its page. */
  onSelect?: (id: string) => void;
  showNew?: boolean;
  fade?: "background" | "card";
  className?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef({ x: 0, left: 0, moved: false, active: false });
  const [edges, setEdges] = useState({ left: false, right: false });
  const [menu, setMenu] = useState<Menu | null>(null);
  const [, start] = useTransition();
  const ordered = [...dots].sort(byImportance);
  const signature = ordered.map((d) => `${d.id}:${dotRank(d)}`).join("|");
  const from = fade === "card" ? "from-card" : "from-background";

  const sync = () => {
    const el = scroller.current;
    if (!el) return;
    setEdges({
      left: el.scrollLeft > 4,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
    });
  };

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    sync();
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth + 1) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!delta) return;
      el.scrollLeft += delta;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => {
      el.removeEventListener("wheel", onWheel);
      observer.disconnect();
    };
  }, [signature]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const scrollBy = (dx: number) => scroller.current?.scrollBy({ left: dx, behavior: "smooth" });

  const openMenu = (e: MouseEvent, id: string) => {
    e.preventDefault();
    setMenu({ id, x: e.clientX, y: e.clientY });
  };

  const chooseRank = (rank: DotRank) => {
    const id = menu?.id;
    setMenu(null);
    if (id) start(() => setDotRank(id, rank));
  };

  return (
    <div className={`relative min-w-0 max-w-full ${className}`}>
      {edges.left && (
        <button
          type="button"
          className={`absolute top-0 bottom-1 left-0 z-10 flex w-7 items-center justify-start bg-gradient-to-r ${from} to-transparent text-foreground/70`}
          onClick={() => scrollBy(-180)}
          aria-label="Scroll dots left"
        >
          <ChevronLeft className="size-4" strokeWidth={1.75} />
        </button>
      )}
      {edges.right && (
        <button
          type="button"
          className={`absolute top-0 right-0 bottom-1 z-10 flex w-7 items-center justify-end bg-gradient-to-l ${from} to-transparent text-foreground/70`}
          onClick={() => scrollBy(180)}
          aria-label="Scroll dots right"
        >
          <ChevronRight className="size-4" strokeWidth={1.75} />
        </button>
      )}
      <div
        ref={scroller}
        onScroll={sync}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const el = scroller.current;
          if (!el) return;
          drag.current = { x: e.clientX, left: el.scrollLeft, moved: false, active: true };
        }}
        onPointerMove={(e) => {
          const el = scroller.current;
          const d = drag.current;
          if (!d.active || !el) return;
          const dx = e.clientX - d.x;
          if (!d.moved && Math.abs(dx) > 6) {
            d.moved = true;
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          }
          if (d.moved) el.scrollLeft = d.left - dx;
        }}
        onPointerUp={() => {
          drag.current.active = false;
        }}
        onPointerCancel={() => {
          drag.current.active = false;
        }}
        onClickCapture={(e) => {
          if (!drag.current.moved) return;
          e.preventDefault();
          e.stopPropagation();
          drag.current.moved = false;
        }}
        className="flex w-full min-w-0 cursor-grab touch-pan-x items-end gap-0.5 overflow-x-auto overscroll-x-contain px-1 pb-1 select-none active:cursor-grabbing [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {ordered.map((d) => {
          const rank = dotRank(d);
          const active = activeId === d.id;
          const body = (
            <>
              <span className={`relative rounded-full ${active ? "outline outline-2 outline-offset-2 outline-foreground/70" : ""}`}>
                <DotOrb look={d.look} status={d.status} size={ORB[rank]} />
                {d.status !== "idle" && <span className={`absolute right-0 bottom-0.5 size-2.5 rounded-full ring-2 ring-card ${statusDot(d)}`} />}
              </span>
              <span className={`w-full truncate text-center text-foreground/70 ${LABEL[rank]} ${active ? "text-foreground" : ""}`}>{d.name}</span>
            </>
          );
          const className = `flex ${SLOT[rank]} shrink-0 flex-col items-center gap-1 rounded-lg py-1.5 transition-colors ${active ? "bg-black/[0.06]" : "hover:bg-black/[0.03]"}`;
          const title = `${d.name}${d.purpose ? ` · ${d.purpose}` : ""} · Right-click to change size`;
          if (onSelect) {
            return (
              <button key={d.id} type="button" className={className} title={title} onClick={() => onSelect(d.id)} onContextMenu={(e) => openMenu(e, d.id)}>
                {body}
              </button>
            );
          }
          return (
            <Link key={d.id} href={`/dots/${d.id}`} onClick={() => markRead(d.id)} onContextMenu={(e) => openMenu(e, d.id)} className={className} title={title}>
              {body}
            </Link>
          );
        })}
        {showNew && (
          <Link href="/new" className="flex w-[60px] shrink-0 flex-col items-center gap-1 rounded-lg py-1.5 text-foreground/45 hover:bg-black/[0.03] hover:text-foreground" title="New dot">
            <span className="flex size-10 items-center justify-center rounded-full border border-dashed border-black/20">
              <Plus className="size-4" strokeWidth={1.75} />
            </span>
            <span className="text-[11px]">New</span>
          </Link>
        )}
      </div>
      {menu &&
        createPortal(
          <div
            className="fixed z-[80] w-44 overflow-hidden rounded-xl border border-black/10 bg-card py-1 shadow-elevated"
            style={{ left: Math.min(menu.x, window.innerWidth - 188), top: Math.min(menu.y, window.innerHeight - 132) }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="px-3 pt-1.5 pb-1 font-mono text-[10px] tracking-wider text-foreground/40 uppercase">Importance</div>
            {RANK_OPTIONS.map((opt) => {
              const current = dots.find((d) => d.id === menu.id);
              const on = current ? dotRank(current) === opt.rank : false;
              return (
                <button
                  key={opt.rank}
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-black/[0.04]"
                  onClick={() => chooseRank(opt.rank)}
                >
                  <span className={`size-2 shrink-0 rounded-full ${on ? "bg-foreground" : "bg-black/15"}`} />
                  <span className="min-w-0">
                    <span className="block text-[13px]">{opt.label}</span>
                    <span className="block text-[11px] text-foreground/45">{opt.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
