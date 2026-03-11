---
date: 2026-03-11
goal: Remove "Games Lost" stat from the Stats Trends table in the phone panel UI
status: ready-for-review
---

## Context

The Stats Trends table in the phone panel currently shows a "Games Lost" row. The task is to remove this row and its associated data calculation — it's noise the user doesn't want to see.

## Changes

**File:** `g2-app/src/phone-panel-app.tsx`

1. **Delete the `gamesLostPerMonth` calculation** (~lines 399–405):
   ```typescript
   const gamesLostPerMonth = cols.map(col =>
     rates.finishedGames.filter(g => {
       if (!g.gameStartTime) return false
       const d = new Date(g.gameStartTime)
       return d.getFullYear() === col.year && d.getMonth() === col.month && deriveOutcome(g) === 'lose'
     }).length
   )
   ```

2. **Delete the "Games Lost" `<tr>` row** (~lines 450–457):
   ```tsx
   <tr>
     <td style={{ padding: '4px 6px', color: '#64748b', fontWeight: 500 }}>Games Lost</td>
     {cols.map((_, ci) => (
       <td key={ci} style={{ textAlign: 'center', padding: '4px 6px', color: '#94a3b8' }}>
         {gamesLostPerMonth[ci] > 0 ? String(gamesLostPerMonth[ci]) : '—'}
       </td>
     ))}
   </tr>
   ```

No other files need changes. The `deriveOutcome` import can stay — it's likely used elsewhere in the file.

## Verification

- After changes, build the g2-app (`npm run build` in `g2-app/`) and confirm no TypeScript errors
- Open the phone panel in a browser and navigate to the Stats tab → Trends table — "Games Lost" row should no longer appear
- Other rows (Games Won, Win Rate, etc.) should be unaffected
