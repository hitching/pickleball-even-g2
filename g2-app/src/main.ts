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
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge, DeviceConnectType,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import { SERVE_OPTIONS, COURT_HALVES, COURT_HALF_INDICES, BLANK_HALF } from './court-images'
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
import { loadConfig, saveConfig, saveGame } from './storage'
import { isAuthenticated, postGame } from './api'
import { playScoreAudio } from './audio'
import { mountPhonePanel, type PhonePanelHandle } from './phone-panel-app'

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

let state: GameState = createInitialState(loadConfig())
let setupTeam: Team = 'us'   // Setup mode: which team serves at game start
let setupPos: 0 | 1 = 0      // Setup mode: position toggle within serving team (0=left, 1=right)
let activeLayout: 'full' | 'compact' | null = null
let startupCreated = false
let bridge: EvenAppBridge | null = null
let eventLoopRegistered = false
let timerIntervalId: number | null = null
let fullDisplayTimeoutId: number | null = null
let audioActive = false       // monitoring mic activity for dynamic rally-end timing

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
// G2 display — container builder (shared by setup and play-full)
// ---------------------------------------------------------------------------

// 8 spaces ≈ 40 px offset for the non-serving team's score line
const SCORE_INDENT = '        ';

// 24 spaces
const WIN_SUFFIX = SCORE_INDENT + SCORE_INDENT + SCORE_INDENT + SCORE_INDENT + 'WIN';

/** Combined score text: top line = them, bottom line = us.
 *  Serving team is left-aligned (x=10); non-serving is indented by SCORE_INDENT. */
function getScoreText(servingTeam: Team, myScore: number, oppScore: number, isGameOver: boolean): string {
  const win = isGameOver
  const themLine = (servingTeam === 'us' ? SCORE_INDENT : '') +
    oppScore + (win && oppScore > myScore ? WIN_SUFFIX : '')
  const usLine   = (servingTeam === 'them' ? SCORE_INDENT : '') +
    myScore + (win && myScore > oppScore ? WIN_SUFFIX : '')
  return `\n${themLine}\n\n\n${usLine}`
}

function buildContainers(scoreText: string, footerText: string) {
  return {
    containerTotalNum: 4,
    imageObject: [
      new ImageContainerProperty({
        containerID: 1,
        containerName: 'pb-court-top',
        xPosition: 90,
        yPosition: 20,
        width: 85,
        height: 69,
      }),
      new ImageContainerProperty({
        containerID: 2,
        containerName: 'pb-court-bottom',
        xPosition: 90,
        yPosition: 89,
        width: 85,
        height: 69,
      }),
    ],
    textObject: [
      new TextContainerProperty({
        containerID: 3,
        containerName: 'pb-score',
        content: scoreText,
        xPosition: 10,
        yPosition: 0, //17,
        width: 320,
        height: 160,
        isEventCapture: 1,
      }),
      new TextContainerProperty({
        containerID: 4,
        containerName: 'pb-footer',
        content: footerText,
        xPosition: 4,
        yPosition: 185,
        width: 568,
        height: 120,
        isEventCapture: 0,
      }),
    ],
  }
}

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
  if (activeLayout !== 'full') return
  const content = `${formatElapsed(state)}\n${getPlayHint(state)}`
  await b.textContainerUpgrade(new TextContainerUpgrade({
    containerID: 4,
    containerName: 'pb-footer',
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
  const prevLayout = activeLayout
  activeLayout = 'compact'  // block tickTimer during stats display
  await Promise.all([
    b.textContainerUpgrade(new TextContainerUpgrade({
      containerID: 3, containerName: 'pb-score',
      contentOffset: 0, contentLength: Math.max(1, text.length), content: text,
    })),
    b.textContainerUpgrade(new TextContainerUpgrade({
      containerID: 4, containerName: 'pb-footer',
      contentOffset: 0, contentLength: 1, content: ' ',
    })),
    b.updateImageRawData(new ImageRawDataUpdate({ containerID: 1, containerName: 'pb-court-top', imageData: BLANK_HALF })),
    b.updateImageRawData(new ImageRawDataUpdate({ containerID: 2, containerName: 'pb-court-bottom', imageData: BLANK_HALF })),
  ])
  await new Promise<void>(r => window.setTimeout(r, 3000))
  if (prevLayout === 'full') {
    await renderFull(b)
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
  if (state.config.listenHideDisplay && activeLayout !== 'compact') {
    // keep mic alive only when stats tracking also wants it
    void renderCompact(b, { keepMic: state.config.listenDetectStats })
  }

  if (state.config.listenDetectStats) {
    scheduleRallyEnd(b)
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

async function updateCourtImages(b: EvenAppBridge, imageKey: string): Promise<void> {
  const [topIdx, bottomIdx] = COURT_HALF_INDICES[imageKey]
  await Promise.all([
    b.updateImageRawData(new ImageRawDataUpdate({
      containerID: 1,
      containerName: 'pb-court-top',
      imageData: COURT_HALVES[topIdx],
    })),
    b.updateImageRawData(new ImageRawDataUpdate({
      containerID: 2,
      containerName: 'pb-court-bottom',
      imageData: COURT_HALVES[bottomIdx],
    })),
  ])
}

async function renderCompact(b: EvenAppBridge, opts: { keepMic?: boolean } = {}): Promise<void> {
  clearFullDisplayTimeout()
  if (!opts.keepMic) stopAudioWatch(b)
  activeLayout = 'compact'  // block tickTimer before any awaits
  const content = state.config.showScoreOnCompact ? compactScoreText(state) : ' '
  await Promise.all([
    b.textContainerUpgrade(new TextContainerUpgrade({
      containerID: 3, containerName: 'pb-score',
      contentOffset: 0, contentLength: Math.max(1, content.length), content,
    })),
    b.textContainerUpgrade(new TextContainerUpgrade({
      containerID: 4, containerName: 'pb-footer',
      contentOffset: 0, contentLength: 1, content: ' ',
    })),
    b.updateImageRawData(new ImageRawDataUpdate({ containerID: 1, containerName: 'pb-court-top', imageData: BLANK_HALF })),
    b.updateImageRawData(new ImageRawDataUpdate({ containerID: 2, containerName: 'pb-court-bottom', imageData: BLANK_HALF })),
  ])
}

async function renderFull(b: EvenAppBridge): Promise<void> {
  const imageKey = state.mode === 'setup'
    ? SERVE_OPTIONS[setupTeam][setupPos]
    : getPlayImageKey(state)
  const scoreText = state.mode === 'setup'
    ? getScoreText(parseSetupOption(SERVE_OPTIONS[setupTeam][setupPos]).servingTeam, 0, 0, false)
    : getScoreText(state.servingTeam, state.myScore, state.oppScore, state.mode === 'gameover')
  const footerText = state.mode === 'setup'
    ? getSetupHint()
    : `${formatElapsed(state)}\n${getPlayHint(state)}`

  if (!startupCreated) {
    // First render ever — establish startup container layout on device
    activeLayout = null
    const cfg = buildContainers(scoreText, footerText)
    await b.createStartUpPageContainer(new CreateStartUpPageContainer(cfg))
    startupCreated = true
    activeLayout = 'full'
    await updateCourtImages(b, imageKey)
  } else {
    activeLayout = 'full'  // set before awaits so tickTimer is unblocked immediately
    await Promise.all([
      b.textContainerUpgrade(new TextContainerUpgrade({
        containerID: 3,
        containerName: 'pb-score',
        contentOffset: 0,
        contentLength: Math.max(1, scoreText.length),
        content: scoreText,
      })),
      b.textContainerUpgrade(new TextContainerUpgrade({
        containerID: 4,
        containerName: 'pb-footer',
        contentOffset: 0,
        contentLength: Math.max(1, footerText.length),
        content: footerText,
      })),
      updateCourtImages(b, imageKey),
    ])
  }
}

async function showFullBriefly(b: EvenAppBridge): Promise<void> {
  clearFullDisplayTimeout()
  await renderFull(b)
  if (state.config.listenHideDisplay || state.config.listenDetectStats) {
    startAudioWatch(b)
  }

  if (state.config.minimizeAfterSecs && state.config.fullDisplaySecs) {
    fullDisplayTimeoutId = window.setTimeout(() => {
      fullDisplayTimeoutId = null
      void renderCompact(b, { keepMic: true })
    }, state.config.fullDisplaySecs * 1000)
  }
}

// ---------------------------------------------------------------------------
// Event loop
// ---------------------------------------------------------------------------

function registerEventLoop(b: EvenAppBridge): void {
  if (eventLoopRegistered) return

  b.onEvenHubEvent(async (event: EvenHubEvent) => {
    console.log('event', event);

    if (event.audioEvent?.audioPcm) {
      processPcmFrame(event.audioEvent.audioPcm, b)
      return
    }

    const rawType = getRawEventType(event);
    console.log('rawType', rawType);

    // ignore disconnected / mystery 7
    if (rawType == 6 || rawType == 7) {
      return;
    }

    let eventType = normalizeEventType(rawType);
    console.log('eventType', eventType);

    // Fallback: event with no explicit type → treat as click
    if (eventType === undefined && (event.listEvent ?? event.textEvent)) {
      eventType = OsEventTypeList.CLICK_EVENT
    }


    switch (eventType) {
      case OsEventTypeList.SCROLL_TOP_EVENT:
        console.log('UP');
        if (state.mode === 'setup') {
          if (setupTeam === 'them') setupPos = setupPos === 0 ? 1 : 0
          else { setupTeam = 'them'; setupPos = 0 }
          await renderFull(b)
        } else {
          // Play or gameover: opponents won the rally
          const prevRallyHitsTop = rallyStats.length > 0 ? [...rallyStats] : undefined
          state = state.servingTeam === 'us'
            ? faultServe(state,  'they_win', prevRallyHitsTop)
            : scorePoint(state, 'they_win', prevRallyHitsTop)
          await showFullBriefly(b)
          void playScoreAudio(state, () => state.config.readAloud)
        }
        panel.update()
        break

      case OsEventTypeList.SCROLL_BOTTOM_EVENT:
        console.log('DOWN');
        if (state.mode === 'setup') {
          if (setupTeam === 'us') setupPos = setupPos === 0 ? 1 : 0
          else { setupTeam = 'us'; setupPos = 0 }
          await renderFull(b)
        } else {
          // Play or gameover: our team won the rally
          const prevRallyHitsBottom = rallyStats.length > 0 ? [...rallyStats] : undefined
          state = state.servingTeam === 'us'
            ? scorePoint(state, 'we_win', prevRallyHitsBottom)
            : faultServe(state,  'we_win', prevRallyHitsBottom)
          await showFullBriefly(b)
          void playScoreAudio(state, () => state.config.readAloud)
        }
        panel.update()
        break

      // CLICK_EVENT = 0 may also appear as undefined — handle both.
      // Setup: starts the game. Play/gameover: toggles compact ↔ full.
      case OsEventTypeList.CLICK_EVENT:
      case undefined:
        console.log('CLICK');
        if (state.mode === 'setup') {
          state = startGame(state, parseSetupOption(SERVE_OPTIONS[setupTeam][setupPos]));
          startPlayTimer(b);
          await showFullBriefly(b);
          void playScoreAudio(state, () => state.config.readAloud);
          panel.update();
        } else {
          if (activeLayout !== 'full') {
            // for toggle without restarting timeout and audio
            clearFullDisplayTimeout()
            await renderFull(b)

          } else {
            await renderCompact(b)
          }
        }
        break

      case OsEventTypeList.DOUBLE_CLICK_EVENT: {
        console.log('DOUBLE CLICK');
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
          await renderFull(b)
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
  state = createInitialState(loadConfig())

  try {
    //bridge = await withTimeout(waitForEvenAppBridge(), 6000)
    bridge = await waitForEvenAppBridge();

    console.log('[pickleball] bridge ready')
  } catch {
    console.warn('[pickleball] bridge unavailable — phone panel only (mock mode)')
  }

  if (bridge) {
    const unsubscribe = bridge.onDeviceStatusChanged((status) => {
      if (status.connectType === DeviceConnectType.Connected) {
        console.log('Device connected!', status.batteryLevel);
      } else {
        console.log('Device not connected!', status.batteryLevel);
      }
    });

    const user = await bridge.getUserInfo();
    console.log('[pickleball] user info:', user);
  }

  if (bridge) {
    console.log(1);
    await renderFull(bridge);
    console.log(2);
    registerEventLoop(bridge);
    console.log(3);
  }
  
  panel = mountPhonePanel(document.getElementById('app')!, {
    getState: () => state,
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
        if (bridge) void renderFull(bridge)
      } else if (prevMode === 'play' && state.mode === 'play') {
        if (bridge) void showFullBriefly(bridge)
      }
      panel.update()
    },
    onConfigChange: (c) => {
      state.config = c
      saveConfig(c)
      if (c.readAloud) void playScoreAudio(state, () => state.config.readAloud)
      panel.update()
    },
  })
  panel.update()

}

main().catch(console.error)
