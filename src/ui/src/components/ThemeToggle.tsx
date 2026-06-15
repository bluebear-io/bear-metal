import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

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

  useEffect(() => {
    applyTheme(theme);

    if (theme !== "system") return;

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme("system");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  function cycle() {
    const next: Theme = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
    if (next === "system") {
      localStorage.removeItem("theme");
    } else {
      localStorage.setItem("theme", next);
    }
    setTheme(next);
  }

  const icons: Record<Theme, React.ReactNode> = {
    system: <Monitor aria-hidden="true" className="size-4" />,
    light: <Sun aria-hidden="true" className="size-4" />,
    dark: <Moon aria-hidden="true" className="size-4" />,
  };

  const labels: Record<Theme, string> = {
    system: "System theme",
    light: "Light theme",
    dark: "Dark theme",
  };

  return (
    <button
      type="button"
      aria-label={labels[theme]}
      title={labels[theme]}
      onClick={cycle}
      className="inline-flex size-9 items-center justify-center rounded-md border border-border-default bg-bg-card text-text-secondary transition hover:border-primary hover:text-primary"
    >
      {icons[theme]}
    </button>
  );
}
