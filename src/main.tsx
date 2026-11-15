import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installViewportFix } from './lib/viewport'
import { call, listCommands, toolDefinitions } from './api'

installViewportFix()

// Programmatic interface: every user action/query as a command (agent bridge, tests, console).
;(window as unknown as { tapin: unknown }).tapin = { call, listCommands: () => listCommands().map((c) => ({ name: c.name, kind: c.kind, description: c.description })), toolDefinitions }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
