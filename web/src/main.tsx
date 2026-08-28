import { createRoot } from 'react-dom/client'
import './index.css'
import '@xterm/xterm/css/xterm.css'
import App from './App.tsx'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// WARDEN-1211 (roadmap WARDEN-1203 "one owner per fact", first CLIENT slice): the
// per-agent /api/git-status fact is owned by TanStack Query — ONE cache key per
// agent (`['git-status', key]`) shared by ChatSidebar's focused-pane read and
// Fleet Health's fan, so the two surfaces can never disagree and an agent held
// by both costs one fetch, not two. Defaults here encode the cadence bar every
// query opts into anyway (see lib/gitStatusHooks GIT_STATUS_QUERY_OPTIONS): no
// retry storms over SSH probes, no focus/reconnect-triggered refetch — facts
// refresh only on a key's first read or an explicit invalidation.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false },
  },
})

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <App />
      <Toaster />
    </TooltipProvider>
  </QueryClientProvider>,
)
