import { useEffect, useState } from "react";
import { Link, Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";

import { ThemeToggle } from "./components/ThemeToggle.js";
import ModelsPage from "./pages/ModelsPage.js";
import SummaryPage from "./pages/SummaryPage.js";
import TicketDetailPage from "./pages/TicketDetailPage.js";
import TicketsListPage from "./pages/TicketsListPage.js";
import WorkersPage from "./pages/WorkersPage.js";

const navClass = ({ isActive }: { isActive: boolean }) =>
  [
    "rounded-md px-3 py-2 text-base font-medium transition",
    isActive ? "border border-border-default bg-bg-card text-primary" : "text-text-secondary hover:bg-bg-card hover:text-primary",
  ].join(" ");

const BearLogo = ({ small }: { small: boolean }) => (
  <div className="flex-shrink-0">
    <img src="/logo.png" alt="Bear Metal" className={`w-auto transition-all duration-300 ${small ? "h-11" : "h-16"}`} />
  </div>
);

const PAGE_TITLES: Record<string, string> = {
  "/": "Tickets",
  "/summary": "Summary",
  "/workers": "Workers",
  "/models": "Models",
};

export default function App() {
  const [scrolled, setScrolled] = useState(false);
  const location = useLocation();

  useEffect(() => {
    const sub = PAGE_TITLES[location.pathname];
    if (sub) document.title = `Bear Metal - ${sub}`;
  }, [location.pathname]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div data-testid="app-root" className="min-h-screen bg-bg-page text-text-primary">
      <header
        className={[
          "fixed inset-x-0 top-0 z-50 border-b border-border-default transition-all duration-300",
          scrolled ? "bg-bg-page/70 backdrop-blur-[1.4px]" : "bg-bg-page",
        ].join(" ")}
      >
        <nav
          className={[
            "mx-auto flex w-full max-w-7xl items-center gap-4 px-6 sm:px-8 transition-all duration-300",
            scrolled ? "py-3" : "py-5",
          ].join(" ")}
        >
          <Link to="/" className="flex items-center mr-2">
            <BearLogo small={scrolled} />
          </Link>
          <div className="h-8 w-px bg-border-default" aria-hidden />
          <NavLink to="/" end className={navClass}>
            Tickets
          </NavLink>
          <NavLink to="/summary" className={navClass}>
            Summary
          </NavLink>
          <NavLink to="/workers" className={navClass}>
            Workers
          </NavLink>
          <NavLink to="/models" className={navClass}>
            Models
          </NavLink>
          <span className="ml-auto">
            <ThemeToggle />
          </span>
        </nav>
      </header>

      <div className="pt-[104px]">
        <Routes>
          <Route path="/" element={<TicketsListPage />} />
          <Route path="/tickets" element={<Navigate to="/" replace />} />
          <Route path="/tickets/:id" element={<TicketDetailPage />} />
          <Route path="/summary" element={<SummaryPage />} />
          <Route path="/workers" element={<WorkersPage />} />
          <Route path="/models" element={<ModelsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  );
}
