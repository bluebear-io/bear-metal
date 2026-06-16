import { BookOpen, Github, Monitor, Moon, Settings, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";

declare const __APP_VERSION__: string;

type Theme = "system" | "light" | "dark";

function applyTheme(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem("theme");
    return stored === "light" || stored === "dark" ? stored : "system";
  });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    applyTheme(theme);

    if (theme !== "system") return;

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme("system");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function selectTheme(t: Theme) {
    if (t === "system") localStorage.removeItem("theme");
    else localStorage.setItem("theme", t);
    setTheme(t);
  }

  const themeOptions: { value: Theme; label: string; icon: React.ReactNode }[] = [
    { value: "system", label: "System", icon: <Monitor className="size-4" aria-hidden /> },
    { value: "light", label: "Light", icon: <Sun className="size-4" aria-hidden /> },
    { value: "dark", label: "Dark", icon: <Moon className="size-4" aria-hidden /> },
  ];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Settings"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex size-9 items-center justify-center rounded-md border border-border-default bg-bg-card text-text-secondary transition hover:border-primary hover:text-primary"
      >
        <Settings className="size-4" aria-hidden />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-64 rounded-md border border-border-default bg-bg-card shadow-lg">
          <div className="px-3 py-2.5 text-xs text-text-secondary">
            Bear Metal <span className="text-text-muted">v{__APP_VERSION__}</span>
          </div>

          <a
            href="https://github.com/bluebear-io/bear-metal/blob/main/README.md"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 border-t border-border-default px-3 py-2.5 text-xs text-text-secondary transition hover:text-primary"
          >
            <BookOpen className="size-3.5" aria-hidden />
            Docs
          </a>

          <a
            href="https://github.com/bluebear-io/bear-metal"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 border-t border-border-default px-3 py-2.5 text-xs text-text-secondary transition hover:text-primary"
          >
            <Github className="size-3.5" aria-hidden />
            Fork me on GitHub
          </a>

          <div className="flex items-center justify-between border-t border-border-default px-3 py-2.5">
            <span className="text-xs text-text-secondary">Theme</span>
            <div className="flex rounded border border-border-default overflow-hidden">
              {themeOptions.map(({ value, label, icon }) => (
                <button
                  key={value}
                  type="button"
                  title={label}
                  onClick={() => selectTheme(value)}
                  className={[
                    "flex items-center justify-center px-2 py-1 text-xs transition",
                    theme === value
                      ? "bg-primary/10 text-primary"
                      : "text-text-secondary hover:text-primary",
                  ].join(" ")}
                >
                  {icon}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
