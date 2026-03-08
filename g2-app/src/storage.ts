// ---------------------------------------------------------------------------
// Persistence — all localStorage access lives here
// ---------------------------------------------------------------------------

import { type Config, type GameState, DEFAULT_CONFIG } from './state'

const CONFIG_KEY     = 'pb-config'
const GAMES_KEY      = 'pb-games'
const READ_ALOUD_KEY = 'pb-read-aloud'

export const MAX_LOCAL_GAMES = 2

export function loadConfig(): Config {
  try {
    const raw = window.localStorage.getItem(CONFIG_KEY)
    if (raw) return { ...DEFAULT_CONFIG, ...JSON.parse(raw) as Partial<Config> }
  } catch { /* ignore */ }
  return { ...DEFAULT_CONFIG }
}

export function saveConfig(config: Config): void {
  try {
    window.localStorage.setItem(CONFIG_KEY, JSON.stringify(config))
  } catch { /* ignore */ }
}

export function loadGames(): GameState[] {
  try {
    const raw = window.localStorage.getItem(GAMES_KEY)
    if (raw) return JSON.parse(raw) as GameState[]
  } catch { /* ignore */ }
  return []
}

export function saveGame(s: GameState): void {
  if (!s.gameStartTime || (s.myScore === 0 && s.oppScore === 0)) return
  const final = { ...s, endTime: Date.now() }
  const existing = loadGames()
  const games = [final, ...existing].slice(0, MAX_LOCAL_GAMES)
  console.log('[pickleball] saving games', games);
  try { window.localStorage.setItem(GAMES_KEY, JSON.stringify(games)) } catch { /* ignore */ }
}

export function loadReadAloud(): boolean {
  try { return localStorage.getItem(READ_ALOUD_KEY) !== 'false' } catch { return true }
}

export function saveReadAloud(v: boolean): void {
  try { localStorage.setItem(READ_ALOUD_KEY, String(v)) } catch { /* ignore */ }
}
