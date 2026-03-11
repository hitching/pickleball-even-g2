# pickleball-even-g2

Pickleball scoring and assistant app for Even Realities G2 smart glasses — monorepo.

## Repo layout

```
pickleball-even-g2/
  g2-app/     Vite + React app that runs on the G2 glasses + phone panel
  backend/    AWS CDK (TypeScript) — Lambda, API Gateway, Cognito, DynamoDB
  .claude/
    plans/    Save implementation plans here (YYYY-MM-DD-description.md)
```

---

## G2 app (`g2-app/`)

See `g2-app/CLAUDE.md` for full detail.

**Dev launch** (via even-dev simulator):
```bash
cd /Users/ritahitching/even-dev
./start-even.sh pickleball
```

**Build / package:**
```bash
cd g2-app
npm run build     # Vite production build
npm run pack      # build + package as pickleball.ehpk
```

**even-dev registration** (`/Users/ritahitching/even-dev/apps.json`):
```json
"pickleball": "/Users/ritahitching/pickleball-even-g2/g2-app"
```

---

## Backend (`backend/`)

See `backend/CLAUDE.md` for full detail.

**Deploy:**
```bash
cd backend
npm run cdk:deploy
```

**Full deploy (build frontend then deploy stack):**
```bash
cd backend
npm run deploy    # runs g2-app build then cdk:deploy
```

**Stack:** `PickleballStack` in `us-east-1`

Resources:
- Cognito User Pool (`pickleball-users`) — email OTP via `USER_AUTH + EMAIL_OTP` flow
- DynamoDB table `pickleball-games` (PK: `userId`, SK: `startTime`)
- HTTP API Gateway (`pickleball-api`) with Cognito JWT authorizer
- 4 Python 3.13 Lambda functions for auth and stats
- CloudFront + S3 for static site hosting at `pickleball.hitching.net`
- API custom domain at `pickleball-api.hitching.net`

---

## API contract

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /auth/send-code | none | InitiateAuth (EMAIL_OTP) → returns `session` |
| POST | /auth/verify | none | RespondToAuthChallenge → returns Cognito IdToken (JWT) |
| GET | /stats | Bearer JWT | Fetch all games for the authenticated user |
| POST | /stats | Bearer JWT | Upload a completed GameState |

**JWT**: Cognito IdToken. `sub` claim = userId (UUID). Frontend stores in `localStorage['pb-auth-token']`.

**DynamoDB schema:**
- PK `userId` (Cognito `sub`), SK `startTime` (ISO 8601)
- Item body: full `GameState` JSON + `email` string

**Cognito session flow**: `POST /auth/send-code` returns a `session` string that must be echoed back in `POST /auth/verify`. The frontend stores this in the module-level `_pendingSession` variable in `g2-app/src/api.ts`.

---

## Key source files

| File | Purpose |
|------|---------|
| `g2-app/src/main.ts` | G2 glasses app entry — bridge init, display rendering, event handling, audio detection |
| `g2-app/src/phone-panel-app.tsx` | React phone panel UI — Game, Stats, Settings, Account tabs |
| `g2-app/src/state.ts` | Game state types, transitions, scoring logic |
| `g2-app/src/api.ts` | Backend API client — auth flow, stats fetch/post |
| `g2-app/src/storage.ts` | localStorage persistence (config + last 2 games) |
| `g2-app/src/audio.ts` | Web Audio score readout via base64 MP3s |
| `g2-app/src/sounds.ts` | Base64-encoded MP3 audio for numbers 0–20 |
| `backend/lib/pickleball-stack.ts` | Full CDK stack definition |
| `backend/lambda/auth/send-code/handler.py` | POST /auth/send-code Lambda |
| `backend/lambda/auth/verify-code/handler.py` | POST /auth/verify Lambda |
| `backend/lambda/stats/get/handler.py` | GET /stats Lambda |
| `backend/lambda/stats/post/handler.py` | POST /stats Lambda |

---

## Environment

After `cdk:deploy`, set in `g2-app/.env`:
```
VITE_API_URL=<ApiUrl from CDK output>
```

---

## Plan Storage

When creating plans, always save them to `.claude/plans/` in the repo root.
Use descriptive filenames like `YYYY-MM-DD-feature-description.md`.
When saving plans, include frontmatter:
- Date
- Goal/objective  
- Status (draft | ready-for-review | in-progress)
After saving any plan file run `hostname` to identify the environment, and when the hostname does not include the string `local` run the following:
`git add .claude/plans/ && git commit -m "plan: <description>" && git push`

