import { createRoot } from 'react-dom/client'
import './index.css'
import '@xterm/xterm/css/xterm.css'
import App from './App.tsx'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'

createRoot(document.getElementById('root')!).render(
  <TooltipProvider>
    <App />
    <Toaster />
  </TooltipProvider>,
)
