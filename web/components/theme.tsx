// The viewer's colour theme has three states: "light" and "dark" stamp
// data-theme on the root element, and "system" removes the attribute entirely
// so that only prefers-color-scheme separates the two palettes. The control is
// the only client script in the feed; everything else is static.

"use client";

import { useEffect, useState } from "react";

type Mode = "system" | "light" | "dark";
const MODES: Mode[] = ["system", "light", "dark"];

function currentMode(): Mode {
  const stamped = document.documentElement.getAttribute("data-theme");
  return stamped === "light" || stamped === "dark" ? stamped : "system";
}

export function ThemeControl() {
  const [mode, setMode] = useState<Mode>("system");

  useEffect(() => {
    setMode(currentMode());
  }, []);

  const choose = (m: Mode) => {
    setMode(m);
    const el = document.documentElement;
    if (m === "system") {
      el.removeAttribute("data-theme");
      try {
        localStorage.removeItem("vouch-theme");
      } catch {}
    } else {
      el.setAttribute("data-theme", m);
      try {
        localStorage.setItem("vouch-theme", m);
      } catch {}
    }
  };

  return (
    <div className="theme" role="group" aria-label="Colour theme">
      {MODES.map((m) => (
        <button key={m} type="button" aria-pressed={mode === m} onClick={() => choose(m)}>
          {m}
        </button>
      ))}
    </div>
  );
}
