import { useCallback, useEffect, useRef, useState } from "react";

// useResizableWidth gives a column a persisted, mouse-draggable width.
// Returns the current width, a ref for the draggable handle element, and
// whether a drag is currently in progress (useful for a "grabbing" cursor
// state on the whole page while dragging).
export function useResizableWidth(storageKey: string, defaultWidth: number, min: number, max: number) {
  const [width, setWidth] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (saved && saved >= min && saved <= max) return saved;
    } catch {
      /* ignore */
    }
    return defaultWidth;
  });
  const [dragging, setDragging] = useState(false);
  const startRef = useRef<{ x: number; width: number } | null>(null);

  const onHandleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startRef.current = { x: e.clientX, width };
      setDragging(true);
    },
    [width],
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const start = startRef.current;
      if (!start) return;
      const next = Math.min(max, Math.max(min, start.width + (e.clientX - start.x)));
      setWidth(next);
    };
    const onUp = () => {
      setDragging(false);
      startRef.current = null;
      setWidth((w) => {
        try {
          localStorage.setItem(storageKey, String(w));
        } catch {
          /* ignore */
        }
        return w;
      });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [dragging, min, max, storageKey]);

  return { width, dragging, onHandleMouseDown };
}
