import type { GameState } from './state'

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'https://api.pickleball.example.com'
const TOKEN_KEY = 'pb-auth-token'

// Short-lived Cognito session string returned by /auth/send-code.
// Must be echoed back in /auth/verify. Not persisted — lives only for the sign-in flow.
let _pendingSession: string | null = null

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export function isAuthenticated(): boolean {
  return getToken() !== null
}

/** Decode the email from the JWT sub claim (no library needed). */
export function getAuthEmail(): string | null {
  const token = getToken()
  if (!token) return null
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>
    return typeof payload.email === 'string' ? payload.email : null
  } catch {
    return null
  }
}

async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = getToken()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers })
  if (res.status === 401) clearToken()
  return res
}

/** POST /auth/send-code — request a magic code sent to the given email. */
export async function sendCode(email: string): Promise<void> {
  const res = await apiFetch('/auth/send-code', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
  if (!res.ok) throw new Error(`sendCode failed: ${res.status}`)
  const { session } = await res.json() as { session: string }
  _pendingSession = session
}

/** POST /auth/verify — exchange email + code for a JWT; stores the token and returns the email. */
export async function verifyCode(email: string, code: string): Promise<string> {
  const session = _pendingSession
  if (!session) throw new Error('No pending session — call sendCode first')
  const res = await apiFetch('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ email, code, session }),
  })
  if (!res.ok) throw new Error(`verifyCode failed: ${res.status}`)
  const { token } = await res.json() as { token: string }
  setToken(token)
  _pendingSession = null
  return email
}

/** GET /stats — fetch all games for the authenticated user. Returns GameState[]. */
export async function fetchStats(): Promise<GameState[]> {
  const res = await apiFetch('/stats')
  if (!res.ok) throw new Error(`fetchStats failed: ${res.status}`)
  return res.json() as Promise<GameState[]>
}

/**
 * POST /stats — upload a completed game.
 * Skips games with no start time or both scores at 0.
 * Throws on non-2xx — caller is responsible for silent-fail handling.
 */
export async function postGame(game: GameState): Promise<void> {
  if (!game.gameStartTime || (game.myScore === 0 && game.oppScore === 0)) return
  const res = await apiFetch('/stats', {
    method: 'POST',
    body: JSON.stringify(game),
  })
  if (!res.ok) throw new Error(`postGame failed: ${res.status}`)
}
