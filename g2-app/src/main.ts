/**
*             ███           █████      ████               █████
*            ░░░           ░░███      ░░███              ░░███ 
*  ████████  ████   ██████  ░███ █████ ░███   ██████   ███████ 
* ░░███░░███░░███  ███░░███ ░███░░███  ░███  ███░░███ ███░░███ 
*  ░███ ░███ ░███ ░███ ░░░  ░██████░   ░███ ░███████ ░███ ░███ 
*  ░███ ░███ ░███ ░███  ███ ░███░░███  ░███ ░███░░░  ░███ ░███ 
*  ░███████  █████░░██████  ████ █████ █████░░██████ ░░████████
*  ░███░░░  ░░░░░  ░░░░░░  ░░░░ ░░░░░ ░░░░░  ░░░░░░   ░░░░░░░░ 
*  ░███                                                        
*  █████                                                       
* ░░░░░                                                        
* 
* Pickleball scorekeeper and coaching for the G2 smart glasses.
* Designed and developed by Bob Hitching.
*/

import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import './styles.css'
import '@jappyjan/even-realities-ui/styles.css'
import {
  type Side,
  type Team,
  type GameState,
  type RallyHit,
  type CompletedRally,
  createInitialState,
  faultServe,
  scorePoint,
  startGame,
  undoOrReset,
  deriveMyRole,
} from './state'
import { loadConfig, saveConfig, saveGame, loadReadAloud, saveReadAloud } from './storage'
import { isAuthenticated, postGame } from './api'
import { playScoreAudio } from './audio'
import { mountPhonePanel, type PhonePanelHandle } from './phone-panel-app'

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

let state: GameState = createInitialState(loadConfig())
let setupTeam: Team = 'us'   // Setup mode: which team serves at game start
let setupPos: 0 | 1 = 0      // Setup mode: position toggle within serving team (0=left, 1=right)
let startupRendered = false
let bridge: EvenAppBridge | null = null
let eventLoopRegistered = false
let timerIntervalId: number | null = null
let displayMode: 'compact' | 'full' = 'compact'
let fullDisplayTimeoutId: number | null = null
let audioActive = false       // monitoring mic activity for dynamic rally-end timing
let readScoresAloud = false   // initialised in main() via loadReadAloud()

// per-rally audio tracking state (reset on each mic activation via resetRallyState)
let audioFrameCount     = 0
let pcmTail             = new Int16Array(0)
let lastHitTimestamp    = 0
let rallyHitTimestamps: number[] = []
let rallyEndTimerId: number | null = null
let rallyStats: RallyHit[] = []
let completedRallies: CompletedRally[] = []
let panel: PhonePanelHandle = { update: () => {} }

// ---------------------------------------------------------------------------
// Event type normalization (timer-app pattern)
// ---------------------------------------------------------------------------

function getRawEventType(event: EvenHubEvent): unknown {
  const raw = (event.jsonData ?? {}) as Record<string, unknown>
  return (
    event.listEvent?.eventType ??
    event.textEvent?.eventType ??
    event.sysEvent?.eventType ??
    (event as Record<string, unknown>).eventType ??
    raw.eventType ??
    raw.event_type ??
    raw.Event_Type ??
    raw.type
  )
}

function normalizeEventType(raw: unknown): OsEventTypeList | undefined {
  if (typeof raw === 'number') {
    switch (raw) {
      case 0: return OsEventTypeList.CLICK_EVENT
      case 1: return OsEventTypeList.SCROLL_TOP_EVENT
      case 2: return OsEventTypeList.SCROLL_BOTTOM_EVENT
      case 3: return OsEventTypeList.DOUBLE_CLICK_EVENT
    }
  }
  if (typeof raw === 'string') {
    const v = raw.toUpperCase()
    if (v.includes('DOUBLE'))                              return OsEventTypeList.DOUBLE_CLICK_EVENT
    if (v.includes('CLICK'))                               return OsEventTypeList.CLICK_EVENT
    if (v.includes('SCROLL_TOP') || v.includes('UP'))     return OsEventTypeList.SCROLL_TOP_EVENT
    if (v.includes('SCROLL_BOTTOM') || v.includes('DOWN')) return OsEventTypeList.SCROLL_BOTTOM_EVENT
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Setup images — one base64 string per config (0-3).
// Images are shown in the right column of the Setup screen (85x138 px).
// The G2 display is 4-bit greyscale — high-contrast images work best.
// ---------------------------------------------------------------------------

const COURT_IMAGES: { [key: string]: string } = {
  'left-serve-1': 'iVBORw0KGgoAAAANSUhEUgAAAFUAAACKAQMAAADhU5TjAAAABlBMVEUAAAD///+l2Z/dAAAAaklEQVR4nGOw/w8DDxgUGIAASoyyhwcbI34ZkNQMQ/YPOPvHoHAPrdmDO/8yI7FZkdicSGxBJDbjIGMPfBgix689hAIDnOwXjz/A2c9j39fD2O/33d9PmH3AHkn8Pw42knpk8z8QdBuCDQDYOqA/w9HZBAAAAABJRU5ErkJggg==',
  'left-serve-2': 'iVBORw0KGgoAAAANSUhEUgAAAFUAAACKAQMAAADhU5TjAAAABlBMVEUAAAD///+l2Z/dAAAAhElEQVR4nGOw/w8DDxgUGIAASoyyhwcbI34ZkNQMQ/YPOPvHoHAPrdmDO//yNyDYAg4ItoICknpS2UjmMCCZz4hkLxMSmwWJzYHEFkBiKyCx7R8gmT/gYYgcv/YQCgxwsl88/gBnP499Xw9jv993fz9h9gF7JPH/ONhI6pHN/0DQbQg2APsjo86N3KsIAAAAAElFTkSuQmCC',
  'left-receive-1': 'iVBORw0KGgoAAAANSUhEUgAAAFUAAACKAQMAAADhU5TjAAAABlBMVEUAAAD///+l2Z/dAAAAbElEQVR4nGOw/w8DDxgUGIAASgwiNjMSmxWJzYnEFkRiMw4y9oCGIUb8MiCpGYbsH3D2j0HhHlqzh0D+HWVTwEaOX3sIBQY42S8ef4Czn8e+r4ex3++7v58w+4A9kvh/HGwk9cjmfyDoNgQbAIPjoD/ONVXXAAAAAElFTkSuQmCC',
  'left-receive-2': 'iVBORw0KGgoAAAANSUhEUgAAAFUAAACKAQMAAADhU5TjAAAABlBMVEUAAAD///+l2Z/dAAAAhklEQVR4nGOw/w8DDxgUGIAASgwiNn8Dgi3ggGArKCCpJ5WNZA4DkvmMSPYyIbFZkNgcSGwBJLYCEtv+wcCHG8Qh6PHLgKRmGLJ/wNk/BoV7aM0eAvl3lE0BGzl+7SEUGOBkv3j8Ac5+Hvu+HsZ+v+/+fsLsA/ZI4v9xsJHUI5v/gaDbEGwA7gSjzi1r5TIAAAAASUVORK5CYII=',
  'left-back-1': 'iVBORw0KGgoAAAANSUhEUgAAAFUAAACKAQMAAADhU5TjAAAABlBMVEUAAAD///+l2Z/dAAAAaklEQVR4nGOw/w8DDxgUGIAASoyyhwcbI34ZkNQMQ/YPOPvHoHAPrdlDIP8yI7FZkdicSGxBJDbjIGMPaBgix689hAIDnOwXjz/A2c9j39fD2O/33d9PmH3AHkn8Pw42knpk8z8QdBuCDQDXVKA/igiKRgAAAABJRU5ErkJggg==',
  'left-back-2': 'iVBORw0KGgoAAAANSUhEUgAAAFUAAACKAQMAAADhU5TjAAAABlBMVEUAAAD///+l2Z/dAAAAg0lEQVR4nGOw/w8DDxgUGIAASoyyhwcbI34ZkNQMQ/YPOPvHoHAPrdlDIP/yNyDYAg4ItoICknpS2UjmMCCZz4hkLxMSmwWJzYHEFkBiKyCx7R8MfLgxoMevPYQCA5zsF48/wNnPY9/Xw9jv993fT5h9wB5J/D8ONpJ6ZPM/EHQbgg0A6HKjzstEGsAAAAAASUVORK5CYII=',
  'left-net-1': 'iVBORw0KGgoAAAANSUhEUgAAAFUAAACKAQMAAADhU5TjAAAABlBMVEUAAAD///+l2Z/dAAAAb0lEQVR4nGOw/w8DDxgUGIAASgwONjMSmxWJzYnEFkRiMw4y9sCHIUb8MiCpGYbsH3D2j0HhHlqzkePXHkIhxLGxXzz+AGc/j31fD2O/33d/P2H2AXsk8f842Ejqkc3/QNBtSGwFCDXi2cjxO4wAAAfOm/+L/jHhAAAAAElFTkSuQmCC',
  'left-net-2': 'iVBORw0KGgoAAAANSUhEUgAAAFUAAACKAQMAAADhU5TjAAAABlBMVEUAAAD///+l2Z/dAAAAiUlEQVR4nGOw/w8DDxgUGIAASgwONn8Dgi3ggGArKCCpJ5WNZA4DkvmMSPYyIbFZkNgcSGwBJLYCEtv+AZL5Ax6GGPHLgKRmGLJ/wNk/BoV7aM1Gjl97CIUQx8Z+8fgDnP089n09jP1+3/39hNkH7JHE/+NgI6lHNv8DQbchsRUg1IhnI8fvMAIAg7qfjiIVHlwAAAAASUVORK5CYII=',
  'right-serve-1': 'iVBORw0KGgoAAAANSUhEUgAAAFUAAACKAQMAAADhU5TjAAAABlBMVEUAAAD///+l2Z/dAAAAZ0lEQVR4nGOw/w8DDxgUGIAASoyyhwcbI34ZkNQMQ/YPOPvHoHAPrdlDIP8yI7FZkdicSGxBJDbjIGMPaBgixy8Y2BPDfvH4A5z9PPZ9PYz9ft/9/YTZB+yRxP/jYCOpRzb/A3HuBABMHaA/Pv3XkwAAAABJRU5ErkJggg==',
  'right-serve-2': 'iVBORw0KGgoAAAANSUhEUgAAAFUAAACKAQMAAADhU5TjAAAABlBMVEUAAAD///+l2Z/dAAAAgElEQVR4nGOw/w8DDxgUGIAASoyyhwcbI34ZkNQMQ/YPOPvHoHAPrdlDIP/yNyDYAg4ItoICknpS2UjmMCCZz4hkLxMSmwWJzYHEFkBiKyCx7R8MfLgxoMcvGNgTw37x+AOc/Tz2fT2M/X7f/f2E2QfskcT/42AjqUc2/wNx7gQAXTujzgU01FQAAAAASUVORK5CYII=',
  'right-receive-1': 'iVBORw0KGgoAAAANSUhEUgAAAFUAAACKAQMAAADhU5TjAAAABlBMVEUAAAD///+l2Z/dAAAAaUlEQVR4nGOw/w8DDxgUGIAASgwONjMSmxWJzYnEFkRiMw4y9sCHIUb8MiCpGYbsH3D2j0HhHlqzB3f+HWVTykaOXzCwJ4b94vEHOPt57Pt6GPv9vvv7CbMP2COJ/8fBRlKPbP4H4twJAPmDoD/PULMfAAAAAElFTkSuQmCC',
  'right-receive-2': 'iVBORw0KGgoAAAANSUhEUgAAAFUAAACKAQMAAADhU5TjAAAABlBMVEUAAAD///+l2Z/dAAAAg0lEQVR4nGOw/w8DDxgUGIAASgwONn8Dgi3ggGArKCCpJ5WNZA4DkvmMSPYyIbFZkNgcSGwBJLYCEtv+AZL5Ax6GGPHLgKRmGLJ/wNk/BoV7aM0e3Pl3lE0pGzl+wcCeGPaLxx/g7Oex7+th7Pf77u8nzD5gjyT+HwcbST2y+R+IcycAdX6jznqJgvcAAAAASUVORK5CYII=',
  'right-back-1': 'iVBORw0KGgoAAAANSUhEUgAAAFUAAACKAQMAAADhU5TjAAAABlBMVEUAAAD///+l2Z/dAAAAZ0lEQVR4nGOw/w8DDxgUGIAASoyyhwcbI34ZkNQMQ/YPOPvHoHAPrdmDO/8yI7FZkdicSGxBJDbjIGMPfBgixy8Y2BPDfvH4A5z9PPZ9PYz9ft/9/YTZB+yRxP/jYCOpRzb/A3HuBABNA6A/9sjhigAAAABJRU5ErkJggg==',
  'right-back-2': 'iVBORw0KGgoAAAANSUhEUgAAAFUAAACKAQMAAADhU5TjAAAABlBMVEUAAAD///+l2Z/dAAAAgUlEQVR4nGOw/w8DDxgUGIAASoyyhwcbI34ZkNQMQ/YPOPvHoHAPrdmDO//yNyDYAg4ItoICknpS2UjmMCCZz4hkLxMSmwWJzYHEFkBiKyCx7R8gmT/gYYgcv2BgTwz7xeMPcPbz2Pf1MPb7fff3E2YfsEcS/4+DjaQe2fwPxLkTAG/so85tNfT6AAAAAElFTkSuQmCC',
  'right-net-1': 'iVBORw0KGgoAAAANSUhEUgAAAFUAAACKAQMAAADhU5TjAAAABlBMVEUAAAD///+l2Z/dAAAAa0lEQVR4nGOw/w8DDxgUGIAASgwiNjMSmxWJzYnEFkRiMw4y9oCGIUb8MiCpGYbsH3D2j0HhHlqzMeLXnhj2i8cf4Oznse/rYez3++7vJ8w+YI8k/h8HG0k9svkfSHGnApJ/RygbOX6HEQAAkOKb/+CH/g0AAAAASUVORK5CYII=',
  'right-net-2': 'iVBORw0KGgoAAAANSUhEUgAAAFUAAACKAQMAAADhU5TjAAAABlBMVEUAAAD///+l2Z/dAAAAhUlEQVR4nGOw/w8DDxgUGIAASgwiNn8Dgi3ggGArKCCpJ5WNZA4DkvmMSPYyIbFZkNgcSGwBJLYCEtv+wcCHG8Qh6PHLgKRmGLJ/wNk/BoV7aM3GiF97YtgvHn+As5/Hvq+Hsd/vu7+fMPuAPZL4fxxsJPXI5n8gxZ0KSP4doWzk+B1GAAD7A5+O1srxiwAAAABJRU5ErkJggg=='
}

const SERVE_OPTIONS: Record<Team, [string, string]> = {
  us:   ['left-back-2',    'right-serve-2'],
  them: ['left-net-2',     'right-receive-2'],
}

function parseSetupOption(key: string): { myPosition: Side; servingTeam: Team } {
  const [position, role] = key.split('-')
  return {
    myPosition: position as Side,
    servingTeam: (role === 'serve' || role === 'back') ? 'us' : 'them',
  }
}

/** Derive the COURT_IMAGES key for the current play state. */
function getPlayImageKey(s: GameState): string {
  const role = deriveMyRole(s)
  return `${s.myPosition}-${role}-${s.serverNumber}`
}

/** Text shown in the play status bar  */
function getPlayHint(s: GameState): string {
  // \u2191 = ↑  \u2193 = ↓  \u25CE = ◎ (double-circle, represents double-click)
  const doubleClickAction = s.mode === 'gameover' ? 'reset' : 'undo';
  return `\u2191 their point  \u2193 our point  \u00b7 toggle display  \u25CE ${doubleClickAction}`;
}

function getSetupHint(): string {
  // ↑ they serve  ↓ we serve  · start
  return `\u2191\u2191 they serve  \u2193\u2193 we serve  \u00b7 start`
}

// ---------------------------------------------------------------------------
// G2 display — container builders
// ---------------------------------------------------------------------------

function buildSetupContainers(imageKey: string) {
  const { servingTeam } = parseSetupOption(imageKey)
  const usX   = servingTeam === 'us'   ? 10 : 50
  const themX = servingTeam === 'them' ? 10 : 50

  return {
    containerTotalNum: 4,
    imageObject: [
      new ImageContainerProperty({
        containerID: 1,
        containerName: 'pb-court-img',
        xPosition: 90,
        yPosition: 10,
        width: 85,
        height: 138,
      }),
    ],
    textObject: [
      new TextContainerProperty({
        containerID: 2,
        containerName: 'pb-score-us',
        content: ' 0',
        xPosition: usX,
        yPosition: 97,
        width: 100,
        height: 80,
        isEventCapture: 1,
      }),
      new TextContainerProperty({
        containerID: 3,
        containerName: 'pb-score-them',
        content: ' 0',
        xPosition: themX,
        yPosition: 17,
        width: 100,
        height: 80,
        isEventCapture: 0,
      }),
      new TextContainerProperty({
        containerID: 4,
        containerName: 'pb-setup',
        content: getSetupHint(),
        xPosition: 4,
        yPosition: 175,
        width: 572,
        height: 120,
        isEventCapture: 0,
      }),
    ],
  }
}

const CHAR_WIDTH_PX = 5      // G2 fixed-width-ish font — tune if needed
const IMAGE_RIGHT_PX = 175   // image xPosition (90) + image width (85)
const HIT_MIN_PEAK    = 2000   // cheap peak gate: skip frames clearly too quiet to contain a hit
const SAMPLE_RATE         = 16000  // G2 mic assumed 16 kHz
const SUBFRAME_SAMPLES    = Math.round(SAMPLE_RATE * 5 / 1000)    // 80 — 5 ms RMS frames
const TAIL_SAMPLES        = Math.round(SAMPLE_RATE * 20 / 1000)   // 320 — 20 ms cross-frame overlap
const HIT_DEBOUNCE_MS     = 250    // ignore new hits within 250 ms of the last
const ONSET_N_STDDEV      = 2.5    // adaptive threshold multiplier: mean + N×σ
const RALLY_END_MIN_MS    = 3000   // minimum rally-end timer delay
const RALLY_END_CADENCE_X = 5      // rally ends after 5× average hit cadence (handles high lobs)
const SPEECH_CAP_MS       = 1500   // faster rally-end cap when speech heuristic fires
const SPEECH_VAR_MAX      = 0.15   // onset variance ratio below which we suspect speech

function buildPlayContainers(s: GameState, statusText: string) {
  const usWon   = s.mode === 'gameover' && s.myScore  > s.oppScore
  const themWon = s.mode === 'gameover' && s.oppScore > s.myScore
  const usX   = s.servingTeam === 'us'   ? 10 : 50
  const themX = s.servingTeam === 'them' ? 10 : 50

  const winPadUs   = Math.ceil((IMAGE_RIGHT_PX - usX)   / CHAR_WIDTH_PX)
  const winPadThem = Math.ceil((IMAGE_RIGHT_PX - themX) / CHAR_WIDTH_PX)
  const scoreUs   = s.myScore.toString().padStart(2, ' ')
  const scoreThem = s.oppScore.toString().padStart(2, ' ')

  return {
    containerTotalNum: 4,
    imageObject: [
      new ImageContainerProperty({
        containerID: 1,
        containerName: 'pb-court-img',
        xPosition: 90,
        yPosition: 10,
        width: 85,
        height: 138,
      }),
    ],
    textObject: [
      new TextContainerProperty({
        containerID: 2,
        containerName: 'pb-score-us',
        content: usWon ? scoreUs.padEnd(winPadUs, ' ') + 'WIN' : scoreUs,
        xPosition: usX,
        yPosition: 97,
        width: 220,
        height: 80,
        isEventCapture: 1,
      }),
      new TextContainerProperty({
        containerID: 3,
        containerName: 'pb-score-them',
        content: themWon ? scoreThem.padEnd(winPadThem, ' ') + 'WIN' : scoreThem,
        xPosition: themX,
        yPosition: 17,
        width: 220,
        height: 80,
        isEventCapture: 0,
      }),
      new TextContainerProperty({
        containerID: 4,
        containerName: 'pb-status',
        content: statusText,
        xPosition: 4,
        yPosition: 175,
        width: 572,
        height: 120,
        isEventCapture: 0,
      }),
    ],
  }
}

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------

function formatElapsed(s: GameState): string {
  if (!s.gameStartTime) return '--:--'
  const ms = Date.now() - s.gameStartTime
  const m = Math.floor(ms / 60000)
  const sec = Math.floor((ms % 60000) / 1000)
  return `Game time ${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}


async function tickTimer(b: EvenAppBridge): Promise<void> {
  if (displayMode !== 'full') return
  const content = `${formatElapsed(state)}\n${getPlayHint(state)}`
  await b.textContainerUpgrade(new TextContainerUpgrade({
    containerID: 4,
    containerName: 'pb-status',
    contentOffset: 0,
    contentLength: Math.max(1, content.length),
    content,
  }))
}

function startPlayTimer(b: EvenAppBridge): void {
  stopPlayTimer()
  timerIntervalId = window.setInterval(() => void tickTimer(b), 1000)
}

function stopPlayTimer(): void {
  if (timerIntervalId !== null) {
    window.clearInterval(timerIntervalId)
    timerIntervalId = null
  }
}

function compactScoreText(s: GameState): string {
  const servingScore   = s.servingTeam === 'us' ? s.myScore  : s.oppScore
  const receivingScore = s.servingTeam === 'us' ? s.oppScore : s.myScore
  const win = s.mode === 'gameover' ? ' WIN' : ''

  return `${servingScore}-${receivingScore}-${s.serverNumber}${win}`
}

function buildCompactContainer(s: GameState) {
  return {
    containerTotalNum: 1,
    textObject: [
      new TextContainerProperty({
        containerID: 1,
        containerName: 'pb-compact',
        content: compactScoreText(s),
        xPosition: 4,
        yPosition: 4,
        width: 572,
        height: 288,
        isEventCapture: 1,
      }),
    ],
  }
}

function clearFullDisplayTimeout(): void {
  if (fullDisplayTimeoutId !== null) {
    window.clearTimeout(fullDisplayTimeoutId)
    fullDisplayTimeoutId = null
  }
}

function stopAudioWatch(b: EvenAppBridge): void {
  if (audioActive) {
    void b.audioControl(false)
    audioActive = false
  }
}

function resetRallyState(): void {
  audioFrameCount    = 0
  pcmTail            = new Int16Array(0)
  lastHitTimestamp   = 0
  rallyHitTimestamps = []
  rallyStats         = []
  if (rallyEndTimerId !== null) {
    window.clearTimeout(rallyEndTimerId)
    rallyEndTimerId = null
  }
}

function startAudioWatch(b: EvenAppBridge): void {
  stopAudioWatch(b)
  resetRallyState()
  audioActive = true
  void b.audioControl(true)
}

function scheduleRallyEnd(b: EvenAppBridge, capMs?: number): void {
  let delay = RALLY_END_MIN_MS
  if (rallyHitTimestamps.length >= 2) {
    let sum = 0
    for (let i = 1; i < rallyHitTimestamps.length; i++)
      sum += rallyHitTimestamps[i] - rallyHitTimestamps[i - 1]
    delay = Math.max(RALLY_END_MIN_MS, RALLY_END_CADENCE_X * (sum / (rallyHitTimestamps.length - 1)))
  }
  if (capMs !== undefined) delay = Math.min(delay, capMs)
  if (rallyEndTimerId !== null) window.clearTimeout(rallyEndTimerId)
  rallyEndTimerId = window.setTimeout(() => { rallyEndTimerId = null; void onRallyEnd(b) }, delay)
}

async function onRallyEnd(b: EvenAppBridge): Promise<void> {
  // Do NOT call resetRallyState() here — rallyStats must survive until the next
  // scoring event snapshots it. Cleanup happens in showFullBriefly → startAudioWatch.
  stopAudioWatch(b)

  if (!state.config.listenDetectStats || rallyStats.length === 0) return

  const hitCount    = rallyStats.length
  const avgCadenceMs = rallyHitTimestamps.length >= 2
    ? (rallyHitTimestamps[rallyHitTimestamps.length - 1] - rallyHitTimestamps[0])
      / (rallyHitTimestamps.length - 1)
    : 0
  const avgPeak     = rallyStats.reduce((s, h) => s + h.peakAmplitude, 0) / hitCount
  const avgAttackMs = rallyStats.reduce((s, h) => s + h.attackMs, 0) / hitCount

  console.log(
    `[pickleball] rally end — ${hitCount} hit(s) avgCadence=${avgCadenceMs.toFixed(0)}ms ` +
    `avgAttack=${avgAttackMs.toFixed(1)}ms avgPeak=${avgPeak.toFixed(0)}`,
  )

  completedRallies.push({ timestamp: Date.now(), hitCount, avgCadenceMs, avgPeak, avgAttackMs })
  panel.update()
  await showRallyStatsBriefly(b, hitCount, avgCadenceMs)
}

async function showRallyStatsBriefly(b: EvenAppBridge, hits: number, cadenceMs: number): Promise<void> {
  const line1 = `Rally: ${hits} hit${hits !== 1 ? 's' : ''}`
  const text  = cadenceMs > 0 ? `${line1}\n~${Math.round(cadenceMs)}ms avg` : line1
  await b.rebuildPageContainer(new RebuildPageContainer({
    containerTotalNum: 1,
    textObject: [
      new TextContainerProperty({
        containerID: 1,
        containerName: 'pb-rally-stats',
        content: text,
        xPosition: 4,
        yPosition: 90,
        width: 572,
        height: 108,
        isEventCapture: 1,
      }),
    ],
  }))
  await new Promise<void>(r => window.setTimeout(r, 3000))
  if (displayMode === 'full') {
    await renderPlay(b)
  } else {
    await renderCompact(b, { keepMic: false })
  }
}

function processPcmFrame(pcm: Uint8Array, b: EvenAppBridge): void {
  if (!audioActive) return

  // 1. Skip first frame after mic activation (unreliable hardware warm-up)
  audioFrameCount++
  const incoming = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1)
  if (audioFrameCount < 6) {
    console.log('[pickleball] early audio frame after mic activation');
    pcmTail = incoming.slice(Math.max(0, incoming.length - TAIL_SAMPLES))
    return
  }

  // 2. Prepend 20 ms tail from previous frame (catches hits that span two frames)
  const combined = new Int16Array(pcmTail.length + incoming.length)
  combined.set(pcmTail, 0)
  combined.set(incoming, pcmTail.length)
  pcmTail = combined.slice(Math.max(0, combined.length - TAIL_SAMPLES))

  // 3. Cheap peak gate — skip frames clearly too quiet to contain a hit
  let peak = 0
  for (let i = 0; i < combined.length; i++) {
    const a = Math.abs(combined[i]); if (a > peak) peak = a
  }
  if (peak < HIT_MIN_PEAK) return;
  //if (peak == 32767) return;

  // 4. RMS energy over 5 ms sub-frames
  const nf = Math.floor(combined.length / SUBFRAME_SAMPLES)
  if (nf < 2) return
  const energy = new Float32Array(nf)
  for (let f = 0; f < nf; f++) {
    let ss = 0
    const base = f * SUBFRAME_SAMPLES
    for (let i = 0; i < SUBFRAME_SAMPLES; i++) { ss += combined[base + i] ** 2 }
    energy[f] = Math.sqrt(ss / SUBFRAME_SAMPLES)
  }

  // 5. Onset strength: positive energy delta catches the attack, not sustained sound
  const onset = new Float32Array(nf)
  for (let i = 1; i < nf; i++) onset[i] = Math.max(0, energy[i] - energy[i - 1])
  console.log('onset', onset);

  // 6. Adaptive threshold: mean + N×stddev of onset values
  let oSum = 0, oSumSq = 0
  for (let i = 1; i < nf; i++) { oSum += onset[i]; oSumSq += onset[i] ** 2 }
  const oc    = nf - 1
  const oMean = oSum / oc
  const oStd  = Math.sqrt(Math.max(0, oSumSq / oc - oMean ** 2))
  const threshold = oMean + ONSET_N_STDDEV * oStd

  // 7. Find first onset peak above adaptive threshold, with 250 ms debounce
  const now = Date.now()
  let hitDetected = false
  for (let i = 1; i < nf; i++) {
    if (onset[i] <= threshold) continue
    if (now - lastHitTimestamp < HIT_DEBOUNCE_MS) break

    // Attack time: count sub-frames from <10% of onset[i] rising to this peak
    let attackStart = i
    for (let k = i - 1; k >= 1; k--) { if (onset[k] < onset[i] * 0.1) break; attackStart = k }
    const attackMs = (i - attackStart) * 5  // 5 ms per sub-frame

    lastHitTimestamp = now
    rallyHitTimestamps.push(now)
    rallyStats.push({ timestamp: now, peakAmplitude: peak, attackMs })
    panel.update()
    console.log(
      `[pickleball] hit peak=${peak} onset=${onset[i].toFixed(1)} ` +
      `thresh=${threshold.toFixed(1)} attack=${attackMs}ms`,
    )
    hitDetected = true
    break  // at most one hit detected per 100 ms frame
  }

  if (!hitDetected) {
    // Speech heuristic: low onset variance + sustained energy → faster rally-end
    if (rallyHitTimestamps.length > 0) {
      let eSum = 0; for (let i = 0; i < nf; i++) eSum += energy[i]
      const meanEnergy = eSum / nf
      if (oStd / (oMean + 1) < SPEECH_VAR_MAX && meanEnergy > 400) {
        console.log(`[pickleball] speech heuristic — oStd/oMean=${(oStd / (oMean + 1)).toFixed(3)} meanEnergy=${meanEnergy.toFixed(1)}`);
        scheduleRallyEnd(b, SPEECH_CAP_MS)
      }
    }
    return
  }

  // 8. On hit: apply mode-specific behaviour
  if (state.config.listenHideDisplay && displayMode !== 'compact') {
    // keep mic alive only when stats tracking also wants it
    void renderCompact(b, { keepMic: state.config.listenDetectStats })
  }

  if (state.config.listenDetectStats) {
    scheduleRallyEnd(b)
  }
}

function buildBlankCompactContainer() {
  return {
    containerTotalNum: 1,
    textObject: [
      new TextContainerProperty({
        containerID: 1,
        containerName: 'pb-compact',
        content: ' ',
        xPosition: 4,
        yPosition: 4,
        width: 572,
        height: 288,
        isEventCapture: 1,
      }),
    ],
  }
}

async function renderCompact(b: EvenAppBridge, opts: { keepMic?: boolean } = {}): Promise<void> {
  clearFullDisplayTimeout()
  if (!opts.keepMic) stopAudioWatch(b)
  displayMode = 'compact'
  const cfg = state.config.showScoreOnCompact
    ? buildCompactContainer(state)
    : buildBlankCompactContainer()
  await b.rebuildPageContainer(new RebuildPageContainer(cfg))
}

async function showFullBriefly(b: EvenAppBridge): Promise<void> {
  clearFullDisplayTimeout()
  displayMode = 'full'
  await renderPlay(b)
  if (state.config.listenHideDisplay || state.config.listenDetectStats) {
    startAudioWatch(b)
  }

  if (state.config.minimizeAfterSecs) {
    fullDisplayTimeoutId = window.setTimeout(() => {
      fullDisplayTimeoutId = null
      void renderCompact(b, { keepMic: true })
    }, state.config.fullDisplaySecs * 1000)
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

async function renderCourtImage(b: EvenAppBridge, imageKey: string): Promise<void> {
  const imageData = COURT_IMAGES[imageKey]
  if (imageData === null) return
  await b.updateImageRawData(new ImageRawDataUpdate({
    containerID: 1,
    containerName: 'pb-court-img',
    imageData,
  }))
}

async function renderPlayImage(b: EvenAppBridge, s: GameState): Promise<void> {
  const key = getPlayImageKey(s);
  await renderCourtImage(b, key);
}

async function renderSetup(b: EvenAppBridge): Promise<void> {
  const key = SERVE_OPTIONS[setupTeam][setupPos]
  const cfg = buildSetupContainers(key)
  if (!startupRendered) {
    await b.createStartUpPageContainer(new CreateStartUpPageContainer(cfg));
    startupRendered = true;

    const user = await b.getUserInfo();
    console.log('[pickleball] user info:', user);
  } else {
    await b.rebuildPageContainer(new RebuildPageContainer(cfg))
  }
  await renderCourtImage(b, key)
}

async function renderPlay(b: EvenAppBridge): Promise<void> {
  const cfg = buildPlayContainers(state, `${formatElapsed(state)}\n${getPlayHint(state)}`)
  if (!startupRendered) {
    await b.createStartUpPageContainer(new CreateStartUpPageContainer(cfg))
    startupRendered = true
  } else {
    await b.rebuildPageContainer(new RebuildPageContainer(cfg))
  }
  await renderPlayImage(b, state)
}

// ---------------------------------------------------------------------------
// Event loop
// ---------------------------------------------------------------------------

function registerEventLoop(b: EvenAppBridge): void {
  if (eventLoopRegistered) return

  b.onEvenHubEvent(async (event: EvenHubEvent) => {
    if (event.audioEvent?.audioPcm) {
      processPcmFrame(event.audioEvent.audioPcm, b)
      return
    }

    const rawType = getRawEventType(event)
    let eventType = normalizeEventType(rawType)

    // Fallback: event with no explicit type → treat as click
    if (eventType === undefined && (event.listEvent ?? event.textEvent)) {
      eventType = OsEventTypeList.CLICK_EVENT
    }


    switch (eventType) {
      case OsEventTypeList.SCROLL_TOP_EVENT:
        if (state.mode === 'setup') {
          if (setupTeam === 'them') setupPos = setupPos === 0 ? 1 : 0
          else { setupTeam = 'them'; setupPos = 0 }
          await renderSetup(b)
        } else {
          // Play or gameover: opponents won the rally
          const prevRallyHitsTop = rallyStats.length > 0 ? [...rallyStats] : undefined
          state = state.servingTeam === 'us'
            ? faultServe(state,  'they_win', prevRallyHitsTop)
            : scorePoint(state, 'they_win', prevRallyHitsTop)
          await showFullBriefly(b)
          void playScoreAudio(state, () => readScoresAloud)
        }
        panel.update()
        break

      case OsEventTypeList.SCROLL_BOTTOM_EVENT:
        if (state.mode === 'setup') {
          if (setupTeam === 'us') setupPos = setupPos === 0 ? 1 : 0
          else { setupTeam = 'us'; setupPos = 0 }
          await renderSetup(b)
        } else {
          // Play or gameover: our team won the rally
          const prevRallyHitsBottom = rallyStats.length > 0 ? [...rallyStats] : undefined
          state = state.servingTeam === 'us'
            ? scorePoint(state, 'we_win', prevRallyHitsBottom)
            : faultServe(state,  'we_win', prevRallyHitsBottom)
          await showFullBriefly(b)
          void playScoreAudio(state, () => readScoresAloud)
        }
        panel.update()
        break

      // CLICK_EVENT = 0 may also appear as undefined — handle both.
      // Setup: starts the game. Play/gameover: toggles compact ↔ full.
      case OsEventTypeList.CLICK_EVENT:
      case undefined:
        if (state.mode === 'setup') {
          state = startGame(state, parseSetupOption(SERVE_OPTIONS[setupTeam][setupPos]))
          startPlayTimer(b)
          await showFullBriefly(b)
          void playScoreAudio(state, () => readScoresAloud)
          panel.update()
        } else {
          if (displayMode === 'compact') {
            // for toggle without restarting timeout and audio
            clearFullDisplayTimeout()
            displayMode = 'full'
            await renderPlay(b)

          } else {
            await renderCompact(b)
          }
        }
        break

      case OsEventTypeList.DOUBLE_CLICK_EVENT: {
        if (state.mode === 'setup') {
          await b.shutDownPageContainer(1)
          return
        }
        const prevMode = state.mode
        saveGame(state)
        if (isAuthenticated()) postGame(state).catch(() => {})
        state = undoOrReset(state)
        if (state.mode === 'setup') {
          // Reverted to Setup (game over reset, or initial-state undo)
          setupTeam = 'us'; setupPos = 0
          completedRallies = []
          stopPlayTimer()
          clearFullDisplayTimeout()
          stopAudioWatch(b)
          displayMode = 'compact'
          await renderSetup(b)
        } else if (prevMode === 'play' && state.mode === 'play') {
          await showFullBriefly(b)
        }
        panel.update()
        break
      }
    }
  })

  eventLoopRegistered = true
  console.log('[pickleball] event loop registered')
}

// ---------------------------------------------------------------------------
// Bridge timeout wrapper
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = window.setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
    promise.then(resolve).catch(reject).finally(() => window.clearTimeout(id))
  })
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  readScoresAloud = loadReadAloud()
  state = createInitialState(loadConfig())

  try {
    bridge = await withTimeout(waitForEvenAppBridge(), 6000)
    console.log('[pickleball] bridge ready')
  } catch {
    console.warn('[pickleball] bridge unavailable — phone panel only (mock mode)')
  }

  panel = mountPhonePanel(document.getElementById('app')!, {
    getState: () => state,
    getReadAloud: () => readScoresAloud,
    getCurrentRallyHits: () => rallyStats,
    onUndo: () => {
      const prevMode = state.mode
      saveGame(state)
      if (isAuthenticated()) postGame(state).catch(() => {})
      state = undoOrReset(state)
      if (state.mode === 'setup') {
        setupTeam = 'us'; setupPos = 0
        completedRallies = []
        stopPlayTimer()
        clearFullDisplayTimeout()
        if (bridge) stopAudioWatch(bridge)
        displayMode = 'compact'
        if (bridge) void renderSetup(bridge)
      } else if (prevMode === 'play' && state.mode === 'play') {
        if (bridge) void showFullBriefly(bridge)
      }
      panel.update()
    },
    onConfigChange: (c) => { state.config = c; saveConfig(c); panel.update() },
    onReadAloudChange: (v) => {
      readScoresAloud = v
      saveReadAloud(v)
      if (v) void playScoreAudio(state, () => readScoresAloud)
      panel.update()
    },
  })
  panel.update()

  if (bridge) {
    await renderSetup(bridge);
    registerEventLoop(bridge);
  }
}

main().catch(console.error)
