import { NavLink, Route, Routes } from "react-router-dom";

import AnalyticsPage from "./pages/AnalyticsPage.js";
import { ThemeToggle } from "./components/ThemeToggle.js";
import TicketDetailPage from "./pages/TicketDetailPage.js";
import TicketsListPage from "./pages/TicketsListPage.js";
import WorkersPage from "./pages/WorkersPage.js";

const navClass = ({ isActive }: { isActive: boolean }) =>
  [
    "rounded-md px-3 py-2 text-base font-medium transition",
    isActive ? "bg-bg-card text-primary" : "text-text-secondary hover:bg-bg-card hover:text-text-primary",
  ].join(" ");

const BearLogo = () => (
  <div className="flex-shrink-0">
    <img src="/logo-bear-metal-dark.png" alt="Bear Metal" className="h-16 w-auto dark:hidden" />
    <img src="/logo-bear-metal.png" alt="Bear Metal" className="hidden h-16 w-auto dark:block" />
  </div>
);

export default function App() {
  return (
    <div data-testid="app-root" className="min-h-screen bg-bg-page text-text-primary">
      <header className="border-b border-border-default bg-bg-page">
        <nav className="mx-auto flex w-full max-w-7xl items-center gap-4 px-6 py-5 sm:px-8">
          <div className="flex items-center gap-3 mr-2">
            <BearLogo />
            <span className="text-2xl font-semibold leading-tight text-primary">Bear Metal</span>
          </div>
          <div className="h-8 w-px bg-border-default" aria-hidden />
          <NavLink to="/" end className={navClass}>
            Tickets
          </NavLink>
          <NavLink to="/workers" className={navClass}>
            Workers
          </NavLink>
          <NavLink to="/analytics" className={navClass}>
            Analytics
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
        <Route path="/analytics" element={<AnalyticsPage />} />
      </Routes>
    </div>
  );
}
