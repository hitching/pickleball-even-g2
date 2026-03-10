// ---------------------------------------------------------------------------
// Game State — pickleball doubles scorer for Even Realities G2
// ---------------------------------------------------------------------------

export type Side      = 'left' | 'right'
export type Team      = 'us' | 'them'
export type Mode      = 'setup' | 'play' | 'gameover'
export type PointOutcome = 'we_win' | 'they_win'
export type MyRole    = 'serve' | 'back' | 'receive' | 'net'
export type GameOutcome = 'win' | 'lose'

export interface RallyHit {
  timestamp:     number   // ms since epoch
  peakAmplitude: number   // raw Int16 peak — proxy for hit power
  attackMs:      number   // ms from 10% to 100% of onset peak
}

export interface CompletedRally {
  timestamp:    number   // Date.now() at rally end
  hitCount:     number
  avgCadenceMs: number   // avg ms between hits; 0 if fewer than 2 hits
  avgPeak:      number
  avgAttackMs:  number
}

export interface Config {
  pointsToWin: number          // default 11
  needTwoPointLead: boolean    // default true
  alwaysStartOnRight: boolean  // true = club rule (always right); false = score-parity rule
  fullDisplaySecs: number      // seconds to show full display before reverting to compact (default 10)
  listenHideDisplay: boolean   // minimize G2 display on first hit detected after scoring
  listenDetectStats: boolean   // keep mic on for full rally; store per-rally stats
  minimizeAfterSecs: boolean   // whether the auto-timeout applies; false = stay full until manual toggle
  showScoreOnCompact: boolean  // show score in compact mode; false = blank/dark display
  readAloud: boolean           // read scores aloud after each point
}

/** Shared court-position state — base for Point and GameState. */
export interface CourtState {
  myScore: number
  oppScore: number
  myPosition: Side            // display-side where "me" is (bottom row)
  servingTeam: Team
  serverNumber: 1 | 2
  servingPosition: Side       // display-side of the current server within their team's row
}

/** Immutable record of one rally, stored in history. */
export interface Point extends CourtState {
  timestamp: number       // ms since epoch when the rally was recorded
  outcome: PointOutcome   // 'we_win' | 'they_win'
  myRole: MyRole          // player's court role at time of rally
  rallyHits?: RallyHit[]  // per-hit data from audio detection; absent when mic was off
}

export interface GameState extends CourtState {
  mode: Mode
  config: Config
  gameStartTime: number | null
  endTime: number | null    // set when game is saved on reset/end
  history: Point[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function opposite(side: Side): Side {
  return side === 'left' ? 'right' : 'left'
}

export function deriveMyRole(
  s: Pick<CourtState, 'myPosition' | 'servingTeam' | 'servingPosition'>
): MyRole {
  if (s.servingTeam === 'us') {
    return s.servingPosition === s.myPosition ? 'serve' : 'back'
  }
  // Diagonal rule: receiver is on the opposite side from the server
  return s.myPosition !== s.servingPosition ? 'receive' : 'net'
}

export function deriveOutcome(s: GameState): GameOutcome {
  if (s.myScore > s.oppScore) return 'win'
  if (s.oppScore > s.myScore) return 'lose'
  const last = s.history[s.history.length - 1]
  return last?.outcome === 'we_win' ? 'win' : 'lose'
}

function toPoint(s: GameState, outcome: PointOutcome, rallyHits?: RallyHit[]): Point {
  return {
    myScore: s.myScore,
    oppScore: s.oppScore,
    myPosition: s.myPosition,
    servingTeam: s.servingTeam,
    serverNumber: s.serverNumber,
    servingPosition: s.servingPosition,
    timestamp: Date.now(),
    outcome,
    myRole: deriveMyRole(s),
    ...(rallyHits && rallyHits.length > 0 ? { rallyHits } : {}),
  }
}

/**
 * Returns the display-side of server 1 for a given team when they start serving.
 *
 * Display convention:
 *   My team's player "right" = display-right.
 *   Opponent team's player "right" (their own right, facing me) = display-LEFT.
 *
 * At score 0, both rules agree: my-server1 → display-right; opp-server1 → display-left.
 */
function getServer1Position(team: Team, score: number, alwaysStartOnRight: boolean): Side {
  if (alwaysStartOnRight) {
    return team === 'us' ? 'right' : 'left'
  }
  // Score-parity rule
  const isEven = score % 2 === 0
  if (team === 'us') return isEven ? 'right' : 'left'
  // Opponents: their "right" is display-left
  return isEven ? 'left' : 'right'
}

function checkWin(myScore: number, oppScore: number, config: Config): Team | null {
  const myWins =
    myScore >= config.pointsToWin &&
    (!config.needTwoPointLead || myScore >= oppScore + 2)
  const oppWins =
    oppScore >= config.pointsToWin &&
    (!config.needTwoPointLead || oppScore >= myScore + 2)
  if (myWins) return 'us'
  if (oppWins) return 'them'
  return null
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: Config = {
  pointsToWin: 11,
  needTwoPointLead: true,
  alwaysStartOnRight: true,
  fullDisplaySecs: 5,
  listenHideDisplay: true,
  listenDetectStats: true,
  minimizeAfterSecs: true,
  showScoreOnCompact: true,
  readAloud: false,
}

export function createInitialState(config: Config = DEFAULT_CONFIG): GameState {
  return {
    mode: 'setup',
    config,
    myScore: 0,
    oppScore: 0,
    myPosition: 'left',
    servingTeam: 'us',
    serverNumber: 2,
    servingPosition: 'left',
    gameStartTime: null,
    endTime: null,
    history: [],
  }
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Transition from Setup → Play with the chosen starting config.
 * Game always starts at score 0-0-2 (server 2 serving).
 */
export function startGame(
  state: GameState,
  cfg: { myPosition: Side; servingTeam: Team },
): GameState {
  const { myPosition, servingTeam } = cfg

  // Server 2 always starts on the right of their own court at score 0.
  // My team's right = display-right; opp's right (facing me) = display-left.
  const servingPosition: Side = servingTeam === 'us' ? 'right' : 'left'

  return {
    ...state,
    mode: 'play',
    myScore: 0,
    oppScore: 0,
    myPosition,
    servingTeam,
    serverNumber: 2,
    servingPosition,
    gameStartTime: Date.now(),
    history: [],
  }
}

/**
 * Scroll-up in Play: serving team scored a point.
 */
export function scorePoint(state: GameState, outcome: PointOutcome, rallyHits?: RallyHit[]): GameState {
  const next = { ...state, history: [...state.history, toPoint(state, outcome, rallyHits)] }

  if (next.servingTeam === 'us') {
    next.myScore++
    next.myPosition = opposite(next.myPosition)
  } else {
    next.oppScore++
  }
  next.servingPosition = opposite(next.servingPosition)

  const winner = checkWin(next.myScore, next.oppScore, next.config)
  if (winner !== null) {
    next.mode = 'gameover'
  }

  return next
}

/**
 * Scroll-down in Play: serving team lost the rally.
 * Advances server 1→2, or causes a side-out (server 2→other team).
 */
export function faultServe(state: GameState, outcome: PointOutcome, rallyHits?: RallyHit[]): GameState {
  const next = { ...state, history: [...state.history, toPoint(state, outcome, rallyHits)] }

  if (next.serverNumber === 1) {
    // Hand off to server 2 of the same team
    next.serverNumber = 2
    next.servingPosition = opposite(next.servingPosition)
  } else {
    // Side-out: other team starts serving
    const newTeam: Team = next.servingTeam === 'us' ? 'them' : 'us'
    const newTeamScore = newTeam === 'us' ? next.myScore : next.oppScore
    next.servingTeam = newTeam
    next.serverNumber = 1
    next.servingPosition = getServer1Position(newTeam, newTeamScore, next.config.alwaysStartOnRight)
    // myPosition does NOT change — players don't physically move on a side-out
  }

  return next
}

/**
 * Double-click in Play:
 * - If game is over → reset to Setup mode (discard any post-win scoring)
 * - If at initial 0-0-2 state → reset to Setup mode
 * - Otherwise → undo last action
 */
export function undoOrReset(state: GameState): GameState {
  if (state.mode === 'gameover') {
    return { ...createInitialState(state.config), mode: 'setup' }
  }

  const isInitial =
    state.myScore === 0 &&
    state.oppScore === 0 &&
    state.serverNumber === 2

  if (isInitial || state.history.length === 0) {
    return { ...createInitialState(state.config), mode: 'setup' }
  }

  const prev = state.history[state.history.length - 1]
  return {
    ...state,
    ...prev,
    mode: 'play',
    history: state.history.slice(0, -1),
  }
}
