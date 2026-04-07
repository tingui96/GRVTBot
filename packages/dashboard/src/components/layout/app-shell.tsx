import { Outlet } from 'react-router-dom';
import { Header } from './header';
import { Sidebar } from './sidebar';
import { BottomNav } from './bottom-nav';

// App-wide chrome: header on top, sidebar on the left (desktop only),
// main content via Outlet, bottom nav on mobile only.
//
// Skip link is the first focusable element so keyboard / screen-reader users
// can jump straight to main content (WCAG 2.4.1).
export function AppShell() {
  return (
    <div className="flex flex-col min-h-dvh bg-bg-base text-text-primary">
      <a
        href="#main-content"
        className="absolute left-2 top-2 z-50 rounded-md bg-primary px-3 py-2 text-xs font-semibold text-bg-base -translate-y-16 focus-visible:translate-y-0 transition-transform"
      >
        Skip to main content
      </a>
      <Header />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 min-w-0 overflow-y-auto p-4 md:p-6 pb-20 md:pb-6 focus:outline-none"
        >
          <Outlet />
        </main>
      </div>
      <BottomNav />
    </div>
  );
}
