"use client";

import { useEffect, useRef, useState } from "react";

function format(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return `${days}日 ${String(hours).padStart(2, "0")}時間 ${String(minutes).padStart(2, "0")}分 ${String(rest).padStart(2, "0")}秒`;
}

export function Countdown({ deadlineAt, serverNow }: { deadlineAt: string; serverNow: string }) {
  const startedAt = useRef<number | null>(null);
  const deadline = new Date(deadlineAt).getTime();
  const baseline = new Date(serverNow).getTime();
  const [remaining, setRemaining] = useState(() => deadline - baseline);

  useEffect(() => {
    startedAt.current = performance.now();
    const update = () => {
      const elapsed = performance.now() - (startedAt.current ?? performance.now());
      const next = Math.max(0, deadline - baseline - elapsed);
      setRemaining(next);
      if (next === 0) window.location.replace("/offer-ended");
    };
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [baseline, deadline]);

  return <p className="countdown" aria-live="polite">受付終了まで：<strong>{format(remaining)}</strong></p>;
}
