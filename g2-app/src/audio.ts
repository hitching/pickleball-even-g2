// ---------------------------------------------------------------------------
// Score readout — plays the current score aloud via Web Audio API
// ---------------------------------------------------------------------------

import { type GameState } from './state'
import { SOUNDS } from './sounds'

export function playNumber(n: number): Promise<void> {
  const data = SOUNDS[n]
  if (!data) return Promise.resolve()
  return new Promise((resolve) => {
    const audio = new Audio(`data:audio/wav;base64,${data}`)
    audio.addEventListener('ended', () => resolve())
    audio.addEventListener('error', () => resolve())
    void audio.play().catch(() => resolve())
  })
}

export async function playScoreAudio(s: GameState, isReadAloud: () => boolean): Promise<void> {
  if (!isReadAloud()) return
  const servingScore   = s.servingTeam === 'us' ? s.myScore  : s.oppScore
  const receivingScore = s.servingTeam === 'us' ? s.oppScore : s.myScore
  for (const n of [servingScore, receivingScore, s.serverNumber]) {
    if (!isReadAloud()) return
    if (n <= 20) {
      await playNumber(n)
    } else {
      const tens  = Math.floor(n / 10) * 10
      const units = n % 10
      await playNumber(tens)
      if (units > 0) {
        if (!isReadAloud()) return
        await playNumber(units)
      }
    }
  }
}
