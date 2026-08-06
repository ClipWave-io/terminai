import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const host = document.getElementById('root')
if (!host) throw new Error('#root is missing from index.html')

// Intentionally not wrapped in StrictMode: its double-invoked effects would
// spawn a second shell process per tab in development.
createRoot(host).render(<App />)
