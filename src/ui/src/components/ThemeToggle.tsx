import { Moon, Sun } from "lucide-react";
import { useState } from "react";

export function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));

  function toggle() {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    setDark(next);
  }

  return (
    <button
      type="button"
      aria-label="Toggle theme"
      aria-pressed={dark}
      onClick={toggle}
      className="inline-flex size-9 items-center justify-center rounded-md border border-border-default bg-bg-card text-text-secondary transition hover:border-primary hover:text-primary"
    >
      {dark ? <Sun aria-hidden="true" className="size-4" /> : <Moon aria-hidden="true" className="size-4" />}
    </button>
  );
}
