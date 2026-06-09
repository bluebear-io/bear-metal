import { NavLink, Route, Routes } from "react-router-dom";

import { ThemeToggle } from "./components/ThemeToggle.js";
import TicketDetailPage from "./pages/TicketDetailPage.js";
import TicketsListPage from "./pages/TicketsListPage.js";
import WorkersPage from "./pages/WorkersPage.js";

const navClass = ({ isActive }: { isActive: boolean }) =>
  [
    "rounded-md px-2.5 py-1.5 text-sm font-medium transition",
    isActive ? "bg-bg-card text-primary" : "text-text-secondary hover:bg-bg-card hover:text-text-primary",
  ].join(" ");

const BearLogo = () => (
  <div className="flex-shrink-0">
    {/* Light mode logo */}
    <img src="/logo-bear.png" alt="BlueBear Security" className="h-7 w-auto dark:hidden" />
    {/* Dark mode logo */}
    <img src="/logo-bear-white.png" alt="BlueBear Security" className="hidden h-7 w-auto dark:block" />
  </div>
);

export default function App() {
  return (
    <div data-testid="app-root" className="min-h-screen bg-bg-page text-text-primary">
      <header className="border-b border-border-default bg-bg-page">
        <nav className="mx-auto flex w-full max-w-7xl items-center gap-4 px-6 py-3 sm:px-8">
          <div className="flex items-center gap-2.5 mr-2">
            <BearLogo />
            <span className="text-[17px] font-semibold leading-tight text-primary">Bear Metal</span>
          </div>
          <div className="h-4 w-px bg-border-default" aria-hidden />
          <NavLink to="/" end className={navClass}>
            Tickets
          </NavLink>
          <NavLink to="/workers" className={navClass}>
            Workers
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
      </Routes>
    </div>
  );
}
