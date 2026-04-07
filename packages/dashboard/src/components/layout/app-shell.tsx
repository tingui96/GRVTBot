import { Outlet } from 'react-router-dom';
import { Header } from './header';
import { Sidebar } from './sidebar';
import { BottomNav } from './bottom-nav';

// App-wide chrome: header on top, sidebar on the left (desktop only),
// main content via Outlet, bottom nav on mobile only.
export function AppShell() {
  return (
    <div className="flex flex-col h-full bg-bg-base text-text-primary">
      <Header />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <main className="flex-1 min-w-0 overflow-y-auto p-4 md:p-6 pb-20 md:pb-6">
          <Outlet />
        </main>
      </div>
      <BottomNav />
    </div>
  );
}
