import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import {
  Button,
  Card,
  CardContent,
  Input,
  Select,
  Switch,
  Text,
} from '@jappyjan/even-realities-ui'
import '@jappyjan/even-realities-ui/styles.css';

import { type Config, type GameState, type RallyHit, type MyRole, type PointOutcome, deriveOutcome, deriveMyRole } from './state'
import { loadGames, MAX_LOCAL_GAMES } from './storage'
import { sendCode, verifyCode, clearToken, isAuthenticated, getAuthEmail, fetchStats, postGame } from './api'

// ---------------------------------------------------------------------------
// Public interface (mirrors the old phone-panel.ts)
// ---------------------------------------------------------------------------

export interface PhonePanelOptions {
  getState: () => GameState
  getCurrentRallyHits: () => RallyHit[]
  onUndo: () => void
  onConfigChange: (c: Config) => void
}

export interface PhonePanelHandle {
  update: () => void
}

// ---------------------------------------------------------------------------
// Tab bar
// ---------------------------------------------------------------------------

type Tab = 'game' | 'stats' | 'settings' | 'account'

const TABS: { id: Tab; label: string }[] = [
  { id: 'game',     label: 'Game' },
  { id: 'stats',    label: 'Stats' },
  { id: 'settings', label: 'Settings' },
  { id: 'account',  label: 'Account' },
]

function TabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  return (
    <div className="flex gap-2">
      {TABS.map(t => (
        <Button
          key={t.id}
          variant={active === t.id ? 'primary' : 'default'}
          size="sm"
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </Button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Game tab
// ---------------------------------------------------------------------------

function formatElapsed(startTime: number | null): string {
  if (!startTime) return '--:--'
  const ms = Date.now() - startTime
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function formatGameDate(ts: number | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  let h = d.getHours()
  const min = String(d.getMinutes()).padStart(2, '0')
  const ampm = h >= 12 ? 'pm' : 'am'
  h = h % 12 || 12
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()} ${h}:${min}${ampm}`
}

function formatDuration(start: number | null, end: number | null): string {
  if (!start) return ''
  const ms = (end ?? Date.now()) - start
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${m}:${String(s).padStart(2, '0')}`
}

function compactScore(state: GameState): string {
  const serving   = state.servingTeam === 'us' ? state.myScore  : state.oppScore
  const receiving = state.servingTeam === 'us' ? state.oppScore : state.myScore
  const win = state.mode === 'gameover' ? ' WIN' : ''
  return `${serving}-${receiving}-${state.serverNumber}${win}`
}

function CurrentRallySparkline({ hits, weServed }: { hits: RallyHit[]; weServed: boolean }) {
  if (hits.length < 2) return null
  const W = 300, H = 56, PX = 4, PY = 4
  const mid = H / 2, halfH = mid - PY
  const maxAmp = Math.max(...hits.map(h => h.peakAmplitude), 1)
  const minT = hits[0].timestamp
  const span = hits[hits.length - 1].timestamp - minT || 1
  const pts = hits.map((h, i) => {
    const isOurs = weServed ? i % 2 === 0 : i % 2 !== 0
    const x = PX + ((h.timestamp - minT) / span) * (W - 2 * PX)
    const y = isOurs ? mid + (h.peakAmplitude / maxAmp) * halfH
                     : mid - (h.peakAmplitude / maxAmp) * halfH
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: 'block' }}>
      <line x1={PX} y1={mid} x2={W - PX} y2={mid} stroke="#e2e8f0" strokeWidth={1} />
      <polyline points={pts} fill="none" stroke="#22c55e" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  )
}

function GameTab({
  state, onUndo, currentRallyHits,
}: {
  state: GameState
  onUndo: () => void
  currentRallyHits: RallyHit[]
}) {
  const [, tick] = useState(0)

  useEffect(() => {
    if (state.mode !== 'play') return
    const id = window.setInterval(() => tick(n => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [state.mode, state.gameStartTime])

  return (
    <div className="flex flex-col gap-3">
      {currentRallyHits.length >= 2 && (
        <Card>
          <CardContent>
            <CurrentRallySparkline hits={currentRallyHits} weServed={state.servingTeam === 'us'} />
          </CardContent>
        </Card>
      )}
      <Card>
        <CardContent>
          <Text
            as="p"
            variant="title-xl"
            className="text-center font-mono tracking-widest py-6 text-4xl"
          >
            {compactScore(state)}
          </Text>
          <Text as="p" variant="subtitle" className="text-center pb-2">
            {formatElapsed(state.gameStartTime)}
          </Text>
        </CardContent>
      </Card>
      <Button variant="default" size="md" onClick={onUndo} className="w-full">
        {(state.mode === 'gameover' ||
          state.history.length === 0 ||
          (state.myScore === 0 && state.oppScore === 0 && state.serverNumber === 2))
          ? 'Reset' : 'Undo'}
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

function SettingsRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <Text variant="body-2">{label}</Text>
      {children}
    </div>
  )
}

function SettingsTab({
  config,
  onConfigChange,
}: {
  config: Config
  onConfigChange: (c: Config) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardContent className="flex flex-col gap-4">
          <Text variant="subtitle">Gameplay</Text>
          <SettingsRow label="Points to win">
            <Input
              type="number"
              min={1}
              max={99}
              value={config.pointsToWin}
              onChange={e => {
                const v = Number.parseInt(e.target.value, 10)
                if (Number.isFinite(v) && v > 0) onConfigChange({ ...config, pointsToWin: v })
              }}
              style={{ width: '4rem' }}
            />
          </SettingsRow>
          <Switch
            label="Win-by-2 points"
            checked={config.needTwoPointLead}
            onChange={e => onConfigChange({ ...config, needTwoPointLead: e.target.checked })}
          />
          <SettingsRow label="First serve">
            <Select
              value={config.alwaysStartOnRight ? 'always-right' : 'by-score'}
              onChange={e =>
                onConfigChange({ ...config, alwaysStartOnRight: e.target.value === 'always-right' })
              }
            >
              <option value="always-right">Always righthand side</option>
              <option value="by-score">Lefthand side for odd scores</option>
            </Select>
          </SettingsRow>
          <Switch
            label="Read scores aloud"
            checked={config.readAloud}
            onChange={e => onConfigChange({ ...config, readAloud: e.target.checked })}
          />
          <Switch
            label="Detect rally stats using microphone"
            checked={config.listenDetectStats}
            onChange={e => onConfigChange({ ...config, listenDetectStats: e.target.checked })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-4">
          <Text variant="subtitle">Heads-up display</Text>
          <Switch
            label="Minimize when serve detected"
            checked={config.listenHideDisplay}
            onChange={e => onConfigChange({ ...config, listenHideDisplay: e.target.checked })}
          />
          <div className="flex items-center gap-2">
            <Switch
              checked={config.minimizeAfterSecs}
              onChange={e => onConfigChange({ ...config, minimizeAfterSecs: e.target.checked })}
            />
            <Text variant="body-2">Minimize after</Text>
            <Input
              type="number"
              min={1}
              max={60}
              disabled={!config.minimizeAfterSecs}
              value={config.fullDisplaySecs}
              onChange={e => {
                const v = Number.parseInt(e.target.value, 10)
                if (Number.isFinite(v) && v >= 1 && v <= 60)
                  onConfigChange({ ...config, fullDisplaySecs: v })
              }}
              style={{ width: '4rem' }}
            />
            <Text variant="body-2">seconds</Text>
          </div>
          <Switch
            label="Display score when minimized"
            checked={config.showScoreOnCompact}
            onChange={e => onConfigChange({ ...config, showScoreOnCompact: e.target.checked })}
          />
        </CardContent>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Data tab
// ---------------------------------------------------------------------------

interface RallyData { hits: RallyHit[]; weServed: boolean; outcome: PointOutcome }

function collectRoleRallies(games: GameState[]): Record<MyRole, RallyData[]> {
  const result: Record<MyRole, RallyData[]> = { serve: [], back: [], receive: [], net: [] }
  for (const g of games) {
    for (const point of g.history) {
      const hits = point.rallyHits ?? []
      const weServed = point.myRole === 'serve' || point.myRole === 'back'
      result[point.myRole].push({ hits, weServed, outcome: point.outcome })
    }
  }
  return result
}

function PointSparkline({
  hits, weServed, outcome, maxAmp, maxSpan, strokeOverride,
}: { hits: RallyHit[]; weServed: boolean; outcome: PointOutcome; maxAmp: number; maxSpan: number; strokeOverride?: string }) {
  if (hits.length < 2) return null
  const W = 72, H = 44, PX = 3, PY = 3
  const mid = H / 2, halfH = mid - PY
  const minT = hits[0].timestamp
  const pts = hits.map((h, i) => {
    const isOurs = weServed ? i % 2 === 0 : i % 2 !== 0
    const x = PX + ((h.timestamp - minT) / maxSpan) * (W - 2 * PX)
    const y = isOurs ? mid + (h.peakAmplitude / maxAmp) * halfH
                     : mid - (h.peakAmplitude / maxAmp) * halfH
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const stroke = strokeOverride ?? (outcome === 'we_win' ? '#22c55e' : '#94a3b8')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: 'block' }}>
      <line x1={PX} y1={mid} x2={W - PX} y2={mid} stroke="#e2e8f0" strokeWidth={1} />
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  )
}

function computeRoleRates(games: GameState[]) {
  const allPoints = games.flatMap(g => g.history)
  const roleRate = (role: string) => {
    const pts = allPoints.filter(p => p.myRole === role)
    return pts.length
      ? Math.round(100 * pts.filter(p => p.outcome === 'we_win').length / pts.length)
      : null
  }
  return {
    serveRate: roleRate('serve'), backRate: roleRate('back'),
    receiveRate: roleRate('receive'), netRate: roleRate('net'),
  }
}

function buildScoreProgression(g: GameState): Array<{ my: number; opp: number }> {
  const pts = g.history.map((_, i) => ({
    my:  g.history[i + 1]?.myScore  ?? g.myScore,
    opp: g.history[i + 1]?.oppScore ?? g.oppScore,
  }))
  return [{ my: 0, opp: 0 }, ...pts]
}

function GameScoreGraph({ game }: { game: GameState }) {
  const data = buildScoreProgression(game)
  if (data.length < 2) return null
  const W = 300, H = 80, PX = 4, PY = 4
  const maxScore = Math.max(game.config.pointsToWin, game.myScore, game.oppScore, 1)
  const n = data.length - 1
  const winnerIsUs = game.mode === 'gameover'
    ? deriveOutcome(game) === 'win'
    : game.myScore >= game.oppScore
  const myColor  = winnerIsUs ? '#22c55e' : '#94a3b8'
  const oppColor = winnerIsUs ? '#94a3b8' : '#22c55e'
  const toX = (i: number) => PX + (i / n) * (W - 2 * PX)
  const toY = (s: number) => (H - PY) - (s / maxScore) * (H - 2 * PY)
  const myPts  = data.map((d, i) => `${toX(i).toFixed(1)},${toY(d.my).toFixed(1)}`).join(' ')
  const oppPts = data.map((d, i) => `${toX(i).toFixed(1)},${toY(d.opp).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: 'block' }}>
      <polyline points={myPts}  fill="none" stroke={myColor}  strokeWidth={1.5} strokeLinejoin="round" />
      <polyline points={oppPts} fill="none" stroke={oppColor} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  )
}

function gameScoreLabel(g: GameState): string {
  if (g.mode === 'gameover') {
    const suffix = deriveOutcome(g) === 'win' ? ' W' : ' L'
    return `${g.myScore} \u2013 ${g.oppScore}${suffix}`
  }
  return `${g.myScore} \u2013 ${g.oppScore}`
}

function lastSixMonths(): { label: string; year: number; month: number }[] {
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const now = new Date()
  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    return { label: names[d.getMonth()], year: d.getFullYear(), month: d.getMonth() }
  })
}

interface TrendsRates {
  gamesWonRate:  number | null
  serveRate:     number | null
  backRate:      number | null
  receiveRate:   number | null
  netRate:       number | null
  finishedGames: GameState[]
}

function TrendsTable({ rates }: { rates: TrendsRates }) {
  const cols = lastSixMonths()
  const gamesPerMonth = cols.map(col =>
    rates.finishedGames.filter(g => {
      if (!g.gameStartTime) return false
      const d = new Date(g.gameStartTime)
      return d.getFullYear() === col.year && d.getMonth() === col.month
    }).length
  )
  const rows: [string, number | null][] = [
    ['Games Won',       rates.gamesWonRate],
    ['Points Won - Serve',  rates.serveRate],
    ['Points Won - Back',   rates.backRate],
    ['Points Won - Receive',rates.receiveRate],
    ['Points Won - Net',    rates.netRate],
  ]
  return (
    <>
      <Text variant="subtitle">Trends</Text>
      <Card>
        <CardContent>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '4px 6px', color: '#94a3b8' }}></th>
                  {cols.map((col, ci) => (
                    <th key={ci} style={{
                      textAlign: 'center', padding: '4px 6px',
                      color: ci === 0 ? '#64748b' : '#94a3b8',
                      fontWeight: ci === 0 ? 600 : 500,
                    }}>
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ padding: '4px 6px', color: '#64748b', fontWeight: 500 }}>Games Played</td>
                  {cols.map((_, ci) => (
                    <td key={ci} style={{ textAlign: 'center', padding: '4px 6px', color: '#94a3b8' }}>
                      {gamesPerMonth[ci] > 0 ? String(gamesPerMonth[ci]) : '—'}
                    </td>
                  ))}
                </tr>
                {rows.map(([label, curRate]) => (
                  <tr key={label}>
                    <td style={{ padding: '4px 6px', color: '#64748b', fontWeight: 500 }}>{label}</td>
                    {cols.map((_, ci) => (
                      <td key={ci} style={{ textAlign: 'center', padding: '4px 6px', color: '#94a3b8' }}>
                        {ci === 0 ? (curRate !== null ? `${curRate}%` : '—') : '—'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </>
  )
}

function mergeGames(cloud: GameState[], local: GameState[]): GameState[] {
  const cloudTimes = new Set(cloud.map(g => g.gameStartTime))
  return [...cloud, ...local.filter(g => !cloudTimes.has(g.gameStartTime))]
}

function DataTab({ state, currentRallyHits, onGoToAccount }: { state: GameState; currentRallyHits: RallyHit[]; onGoToAccount: () => void }) {
  const [cloudGames, setCloudGames] = useState<GameState[] | null>(null)

  useEffect(() => {
    if (!isAuthenticated()) return
    fetchStats().then(setCloudGames).catch(() => {})
  }, [])

  const localGames = loadGames()
  const completedGames = cloudGames == null ? localGames : mergeGames(cloudGames, localGames)
  const sparklineGames = state.history.length > 0 ? [...completedGames, state] : completedGames
  const sortedCompleted = [...completedGames].sort(
    (a, b) => (b.gameStartTime ?? 0) - (a.gameStartTime ?? 0)
  )
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
  const todayCount = sortedCompleted.filter(g => (g.gameStartTime ?? 0) >= todayStart.getTime()).length
  const cappedCompleted = sortedCompleted.slice(0, Math.max(10, todayCount))
  const gamesToShow = state.mode === 'play' ? [state, ...cappedCompleted] : cappedCompleted

  if (!sparklineGames.length && !gamesToShow.length) {
    return (
      <Card>
        <CardContent>
          <Text as="p" variant="body-2" className="text-center py-4">
            No data yet
          </Text>
        </CardContent>
      </Card>
    )
  }

  const { serveRate, backRate, receiveRate, netRate } = computeRoleRates(sparklineGames)
  const currentRole: MyRole | null = state.mode === 'play' ? deriveMyRole(state) : null
  const hasLiveRally = currentRole !== null && currentRallyHits.length >= 2
  const finishedGames = state.mode === 'gameover' ? [state, ...completedGames] : completedGames
  const gamesWonRate = finishedGames.length
    ? Math.round(100 * finishedGames.filter(g => deriveOutcome(g) === 'win').length / finishedGames.length)
    : null
  const hasRoleData = [serveRate, backRate, receiveRate, netRate].some(r => r !== null)

  const roleRallies = collectRoleRallies(sparklineGames)
  const allHits = Object.values(roleRallies).flat().flatMap(r => r.hits)
  const globalMaxAmp = allHits.length ? Math.max(...allHits.map(h => h.peakAmplitude)) : 1

  const recentByRole = Object.fromEntries(
    (['serve', 'back', 'receive', 'net'] as MyRole[]).map(role => [
      role, roleRallies[role].slice(-4).reverse(),
    ])
  ) as Record<MyRole, RallyData[]>

  const globalMaxSpan = Math.max(
    1,
    ...(['serve', 'back', 'receive', 'net'] as MyRole[])
      .flatMap(role => recentByRole[role])
      .map(r => r.hits.length > 1 ? r.hits[r.hits.length - 1].timestamp - r.hits[0].timestamp : 1)
  )

  const liveSpan = hasLiveRally
    ? Math.max(1, currentRallyHits[currentRallyHits.length - 1].timestamp - currentRallyHits[0].timestamp)
    : 1

  const roles: [string, MyRole, number | null][] = [
    ['Serve', 'serve', serveRate], ['Back', 'back', backRate],
    ['Receive', 'receive', receiveRate], ['Net', 'net', netRate],
  ]

  return (
    <div className="flex flex-col gap-3">

      {sparklineGames.length > 0 && (
        <>
          <Text variant="subtitle">Points</Text>
          {roles.map(([label, roleKey, rate]) => {
            const showLive = hasLiveRally && roleKey === currentRole
            const historicalSlots = recentByRole[roleKey].slice(0, showLive ? 3 : 4)
            return (
              <Card key={label}>
                <CardContent className="flex flex-col gap-2">
                  <div className="flex justify-between">
                    <Text variant="detail">{label}</Text>
                    <Text variant="detail">{rate !== null ? `${rate}%` : '—'}</Text>
                  </div>
                  {(showLive || historicalSlots.length > 0) && (
                    <div style={{ display: 'flex', gap: '4px' }}>
                      {showLive && (
                        <div style={{ flex: '0 0 calc(25% - 3px)' }}>
                          <PointSparkline
                            hits={currentRallyHits}
                            weServed={state.servingTeam === 'us'}
                            outcome="we_win"
                            maxAmp={globalMaxAmp}
                            maxSpan={liveSpan}
                            strokeOverride="#f59e0b"
                          />
                          <div style={{ fontSize: '9px', textAlign: 'center', color: '#f59e0b', lineHeight: 1.2 }}>
                            LIVE
                          </div>
                        </div>
                      )}
                      {historicalSlots.map((rally, i) => {
                        const count = rally.hits.length
                        const cadenceMs = count >= 2
                          ? Math.round(
                              (rally.hits[count - 1].timestamp - rally.hits[0].timestamp) / (count - 1)
                            )
                          : null
                        return (
                          <div key={i} style={{ flex: '0 0 calc(25% - 3px)' }}>
                            {count >= 2 ? (
                              <PointSparkline
                                hits={rally.hits}
                                weServed={rally.weServed}
                                outcome={rally.outcome}
                                maxAmp={globalMaxAmp}
                                maxSpan={globalMaxSpan}
                              />
                            ) : (
                              <div style={{
                                height: 44,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                color: rally.outcome === 'we_win' ? '#22c55e' : '#94a3b8',
                                fontSize: '11px',
                                fontWeight: 600,
                              }}>
                                {rally.outcome === 'we_win' ? 'WIN' : 'LOSE'}
                              </div>
                            )}
                            {count > 0 && (
                              <div style={{ fontSize: '9px', textAlign: 'center', color: '#94a3b8', lineHeight: 1.2 }}>
                                {count}h{cadenceMs !== null ? ` ~${cadenceMs}ms` : ''}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </>
      )}

      {hasRoleData && false && (
        <Card>
          <CardContent>
            <Text as="p" variant="detail">
              Create an account to receive coaching tips based on your points data.
            </Text>
          </CardContent>
        </Card>
      )}

      {gamesToShow.length > 0 && (
        <>
          <Text variant="subtitle">Games</Text>
          {!isAuthenticated() && (
            <p style={{ margin: 0, fontSize: '12px', color: '#64748b', lineHeight: 1.4 }}>
              Current limit: {MAX_LOCAL_GAMES} games.{' '}
              <button
                onClick={onGoToAccount}
                style={{
                  background: 'none', border: 'none', padding: 0,
                  color: '#22c55e', textDecoration: 'underline',
                  fontSize: 'inherit', cursor: 'pointer',
                }}
              >
                Sign in
              </button>
              {' '}to save unlimited games and unlock trends and insights.
            </p>
          )}
          {gamesToShow.map((g, i) => (
            <Card key={i}>
              <CardContent className="flex flex-col gap-2">
                <div className="flex justify-between items-baseline">
                  <Text variant="body-2">{gameScoreLabel(g)}</Text>
                  <Text variant="detail" style={{ color: '#94a3b8' }}>
                    <>
                      {formatGameDate(g.gameStartTime)}
                      {g.gameStartTime && ` +${formatDuration(g.gameStartTime, g.endTime)}`}
                    </>
                  </Text>
                </div>
                <GameScoreGraph game={g} />
              </CardContent>
            </Card>
          ))}
        </>
      )}

      <TrendsTable rates={{ gamesWonRate, serveRate, backRate, receiveRate, netRate, finishedGames }} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Account tab
// ---------------------------------------------------------------------------

type AuthStep = 'idle' | 'codeSent' | 'signedIn'

function AccountTab() {
  const [step, setStep] = useState<AuthStep>(isAuthenticated() ? 'signedIn' : 'idle')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const signedInEmail = getAuthEmail()
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())

  async function handleSendCode() {
    setError(null)
    setLoading(true)
    try {
      await sendCode(email.trim())
      setStep('codeSent')
    } catch {
      setError('Could not send code. Check your email address and try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleVerify() {
    setError(null)
    setLoading(true)
    try {
      await verifyCode(email.trim(), code.trim())
      setStep('signedIn')
      setCode('')
      for (const game of loadGames()) {
        postGame(game).catch(() => {})
      }
    } catch {
      setError('Invalid code. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  function handleSignOut() {
    clearToken()
    setStep('idle')
    setEmail('')
    setError(null)
  }

  if (step === 'signedIn') {
    return (
      <Card>
        <CardContent className="flex flex-col gap-4">
          <Text variant="subtitle">Signed in</Text>
          <Text variant="body-2">{signedInEmail ?? 'Unknown email'}</Text>
          <Button variant="default" size="sm" onClick={handleSignOut}>Sign out</Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardContent className="flex flex-col gap-4">
          <Text variant="subtitle">Sign in with email</Text>
          <Text variant="detail">We'll send a one-time code to your email address.</Text>
          <Input
            type="email"
            placeholder="you@example.com"
            value={email}
            disabled={step === 'codeSent' || loading}
            onChange={e => setEmail(e.target.value)}
          />
          {step === 'idle' && (
            <Button
              variant="primary"
              size="sm"
              disabled={!emailValid || loading}
              onClick={() => void handleSendCode()}
            >
              {loading ? 'Sending…' : 'Send code'}
            </Button>
          )}
          {step === 'codeSent' && (
            <>
              <Input
                type="text"
                inputMode="numeric"
                placeholder="Enter code"
                value={code}
                disabled={loading}
                onChange={e => setCode(e.target.value)}
              />
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!code.trim() || loading}
                  onClick={() => void handleVerify()}
                >
                  {loading ? 'Verifying…' : 'Verify'}
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  disabled={loading}
                  onClick={() => { setStep('idle'); setCode(''); setError(null) }}
                >
                  Back
                </Button>
              </div>
            </>
          )}
          {error && (
            <Text variant="detail" style={{ color: '#ef4444' }}>{error}</Text>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Root app component
// ---------------------------------------------------------------------------

function PhoneApp({ opts }: { opts: PhonePanelOptions }) {
  const [tab, setTab] = useState<Tab>('game')
  const state = opts.getState()

  return (
    <div className="px-4 py-4 flex flex-col gap-4 max-w-lg">
      <Text as="h1" variant="title-1">Pickleball</Text>
      <TabBar active={tab} onChange={setTab} />
      {tab === 'game' && (
        <GameTab
          state={state}
          onUndo={opts.onUndo}
          currentRallyHits={opts.getCurrentRallyHits()}
        />
      )}
      {tab === 'settings' && (
        <SettingsTab
          config={state.config}
          onConfigChange={opts.onConfigChange}
        />
      )}
      {tab === 'stats' && <DataTab state={state} currentRallyHits={opts.getCurrentRallyHits()} onGoToAccount={() => setTab('account')} />}
      {tab === 'account' && <AccountTab />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Mount function — bridges imperative panel.update() calls into React
// ---------------------------------------------------------------------------

export function mountPhonePanel(
  container: HTMLElement,
  opts: PhonePanelOptions,
): PhonePanelHandle {
  let externalTick: (() => void) | null = null

  function Root() {
    const [, setTick] = useState(0)
    useEffect(() => {
      externalTick = () => setTick(t => t + 1)
      return () => { externalTick = null }
    }, [])
    return <PhoneApp opts={opts} />
  }

  const root = ReactDOM.createRoot(container)
  root.render(<Root />)

  return { update: () => externalTick?.() }
}
