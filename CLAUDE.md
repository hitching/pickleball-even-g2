# pickleball-even-g2

Pickleball scoring and assistant app for Even Realities G2 smart glasses — monorepo.

## Repo layout

```
pickleball-even-g2/
  g2-app/     Vite + React app that runs on the G2 glasses + phone panel
  backend/    AWS CDK (TypeScript) — Lambda, API Gateway, Cognito, DynamoDB
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
npm run cdk deploy
```

**Stack:** `PickleballStack` in `us-east-1`

Resources:
- Cognito User Pool — email OTP via custom auth flow + SES
- DynamoDB table `pickleball-games` (PK: `userId`, SK: `startTime`)
- HTTP API Gateway with Cognito JWT authorizer
- Lambda functions for auth and stats

---

## API contract

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /auth/send-code | none | Initiate Cognito CUSTOM_AUTH, send OTP via SES |
| POST | /auth/verify | none | Submit OTP → returns Cognito IdToken (JWT) |
| GET | /stats | Bearer JWT | Fetch all games for the authenticated user |
| POST | /stats | Bearer JWT | Upload a completed GameState |

**JWT**: Cognito IdToken. `sub` claim = userId (UUID). Frontend stores in `localStorage['pb-auth-token']`.

**DynamoDB schema:**
- PK `userId` (Cognito sub), SK `startTime` (ISO 8601)
- Item body: full `GameState` JSON + `email` string

**Note on Cognito session**: `POST /auth/send-code` returns a `session` string that must be passed back in `POST /auth/verify`. The frontend stores this in a module-level variable in `g2-app/src/api.ts`.

---

## Environment

After `cdk deploy`, set in `g2-app/.env`:
```
VITE_API_URL=<API Gateway URL from CDK output>
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

