import { NavLink, Route, Routes } from "react-router-dom";

import { ThemeToggle } from "./components/ThemeToggle.js";
import TicketDetailPage from "./pages/TicketDetailPage.js";
import TicketsListPage from "./pages/TicketsListPage.js";
import TimeSavedPage from "./pages/TimeSavedPage.js";
import WorkersPage from "./pages/WorkersPage.js";

const navClass = ({ isActive }: { isActive: boolean }) =>
  [
    "rounded-md px-2.5 py-1.5 text-sm font-medium transition",
    isActive ? "bg-bg-card text-primary" : "text-text-secondary hover:bg-bg-card hover:text-text-primary",
  ].join(" ");

export default function App() {
  return (
    <div data-testid="app-root" className="min-h-screen bg-bg-page text-text-primary">
      <header className="border-b border-border-default bg-bg-page">
        <nav className="mx-auto flex w-full max-w-7xl items-center gap-3 px-6 py-4 sm:px-8">
          <span className="mr-2 text-base font-semibold">Bear Metal</span>
          <NavLink to="/" end className={navClass}>
            Tickets
          </NavLink>
          <NavLink to="/workers" className={navClass}>
            Workers
          </NavLink>
          <NavLink to="/time-saved" className={navClass}>
            Time Saved
          </NavLink>
          <span className="ml-auto">
            <ThemeToggle />
          </span>
        </nav>
      </header>

      <Routes>
        <Route path="/" element={<TicketsListPage />} />
        <Route path="/tickets" element={<TicketsListPage />} />
        <Route path="/tickets/:id" element={<TicketDetailPage />} />
        <Route path="/workers" element={<WorkersPage />} />
        <Route path="/time-saved" element={<TimeSavedPage />} />
      </Routes>
    </div>
  );
}
