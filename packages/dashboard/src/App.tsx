import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { AppShell } from './components/layout/app-shell';
import { OverviewPage } from './pages/overview';
import { BotsListPage } from './pages/bots-list';
import { SettingsPage } from './pages/settings';

// Bot Detail owns the heaviest dependencies (lightweight-charts + recharts).
// Lazy-load it so the Overview page doesn't pay the cost on first paint.
const BotDetailPage = lazy(() =>
  import('./pages/bot-detail').then((m) => ({ default: m.BotDetailPage }))
);

function RouteFallback() {
  return (
    <div className="flex items-center justify-center h-64 text-sm text-text-muted animate-pulse">
      Loading…
    </div>
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<OverviewPage />} />
            <Route path="bots" element={<BotsListPage />} />
            <Route
              path="bots/:id"
              element={
                <Suspense fallback={<RouteFallback />}>
                  <BotDetailPage />
                </Suspense>
              }
            />
            <Route path="history" element={<Navigate to="/" replace />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
      <Toaster
        theme="dark"
        position="bottom-right"
        toastOptions={{
          style: {
            background: 'var(--color-bg-elevated)',
            color: 'var(--color-text-primary)',
            border: '1px solid var(--color-border-default)',
          },
        }}
      />
    </QueryClientProvider>
  );
}
