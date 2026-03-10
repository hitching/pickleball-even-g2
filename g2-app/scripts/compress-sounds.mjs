// Compress sounds.ts: re-encodes base64 WAV files as MP3 (32kbps mono 16kHz)
// Requires: ffmpeg in PATH
// Run from g2-app/: node scripts/compress-sounds.mjs

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { execSync } from 'child_process'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
const srcPath = join(__dir, '../src/sounds.ts')
const src = readFileSync(srcPath, 'utf8')

// Match lines like:  0: 'base64...',
const matches = [...src.matchAll(/^\s+(\w+):\s*'([^']+)'/gm)]
if (!matches.length) throw new Error('No sounds found — check regex against sounds.ts structure')

console.log(`Found ${matches.length} sounds. Compressing...`)

const tmpDir = join(tmpdir(), 'compress-sounds-' + Date.now())
mkdirSync(tmpDir)

const results = {}
for (const [, key, b64] of matches) {
  const wavPath = join(tmpDir, `${key}.wav`)
  const mp3Path = join(tmpDir, `${key}.mp3`)
  writeFileSync(wavPath, Buffer.from(b64, 'base64'))
  execSync(
    `ffmpeg -i "${wavPath}" -codec:a libmp3lame -b:a 32k -ac 1 -ar 16000 -y "${mp3Path}" -loglevel error`
  )
  results[key] = readFileSync(mp3Path).toString('base64')
  process.stdout.write(`  ${key}: ${b64.length} → ${results[key].length} chars\n`)
}

rmSync(tmpDir, { recursive: true })

// Preserve the header comment block, rewrite export
const headerEnd = src.indexOf('\nexport')
const header = src.slice(0, headerEnd)
const entries = Object.entries(results).map(([k, v]) => `  ${k}: '${v}'`).join(',\n')
const output = `${header}\nexport const SOUNDS: Partial<Record<number, string>> = {\n${entries},\n}\n`
writeFileSync(srcPath, output)

const before = Math.round(src.length / 1024)
const after = Math.round(output.length / 1024)
console.log(`\nDone. sounds.ts: ${before} KB → ${after} KB`)
