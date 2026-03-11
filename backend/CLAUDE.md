# backend — AWS CDK (TypeScript)

Pickleball G2 backend: Cognito email OTP auth, API Gateway, Lambda, DynamoDB. Region: `us-east-1`.

---

## Prerequisites

1. AWS CLI configured (`aws configure` or `AWS_PROFILE` set)
2. CDK bootstrapped: `npx cdk bootstrap aws://ACCOUNT/us-east-1`
3. SES sender verified in AWS console (see SES section below)
4. Install deps: `npm install`

---

## Commands

```bash
npm run cdk:synth    # Synthesise CloudFormation — no AWS calls
npm run cdk:diff     # Show what will change vs deployed stack
npm run cdk:deploy   # Deploy to AWS (us-east-1)
npm run cdk:destroy  # Tear down stack (DynamoDB and User Pool have RETAIN policy)
npm run deploy       # Full deploy: build g2-app then cdk:deploy
```

---

## Stack resources

| Resource | Name / ID | Notes |
|----------|-----------|-------|
| DynamoDB | `pickleball-games` | PK: `userId`, SK: `startTime` (ISO 8601); PAY_PER_REQUEST; RETAIN on destroy |
| Cognito User Pool | `pickleball-users` | Email sign-in; `USER_AUTH + EMAIL_OTP` flow; no password |
| Cognito App Client | `pickleball-app` | `ALLOW_USER_AUTH + ALLOW_REFRESH_TOKEN_AUTH`; no secret |
| HTTP API | `pickleball-api` | CORS open (all origins, GET/POST/OPTIONS); JWT authorizer on `/stats` |
| Lambda ×4 | see `lambda/` | Python 3.13 runtime |
| S3 bucket | (auto-named) | Private; SSL enforced; hosts built `dist/` |
| CloudFront | — | OAC distribution; SPA fallback (404/403 → index.html); at `pickleball.hitching.net` |
| ACM cert (frontend) | — | `pickleball.hitching.net` |
| ACM cert (API) | — | `pickleball-api.hitching.net` |

---

## API routes

| Method | Path | Auth | Lambda |
|--------|------|------|--------|
| POST | /auth/send-code | none | `lambda/auth/send-code/handler.py` |
| POST | /auth/verify | none | `lambda/auth/verify-code/handler.py` |
| GET | /stats | Cognito JWT | `lambda/stats/get/handler.py` |
| POST | /stats | Cognito JWT | `lambda/stats/post/handler.py` |

---

## Auth flow (Cognito `USER_AUTH + EMAIL_OTP`)

1. **POST /auth/send-code** `{ email }`:
   - Ensures user exists in Cognito (creates if not)
   - Calls `InitiateAuth(AUTH_FLOW="USER_AUTH", PREFERRED_CHALLENGE="EMAIL_OTP")`
   - Cognito sends a one-time code to the user's email via SES
   - Returns `{ session }` — **must be echoed back in the next call**

2. **POST /auth/verify** `{ email, code, session }`:
   - Calls `RespondToAuthChallenge(CHALLENGE_NAME="EMAIL_OTP")`
   - Returns `{ token }` — Cognito IdToken (JWT)

**JWT**: `sub` claim = userId (Cognito UUID). Frontend stores in `localStorage['pb-auth-token']`.

---

## Lambda structure

```
lambda/
  auth/
    send-code/
      handler.py    POST /auth/send-code — InitiateAuth (EMAIL_OTP)
    verify-code/
      handler.py    POST /auth/verify    — RespondToAuthChallenge → IdToken
  stats/
    get/
      handler.py    GET  /stats          — query DynamoDB by userId (ascending by startTime)
    post/
      handler.py    POST /stats          — put GameState in DynamoDB
```

All handlers use **Python 3.13** runtime. The stats handlers extract `userId` from the JWT `sub` claim passed via the API Gateway JWT authorizer context.

---

## DynamoDB schema

- **Table**: `pickleball-games`
- **PK**: `userId` — Cognito `sub` (UUID string)
- **SK**: `startTime` — ISO 8601 timestamp (converted from ms epoch in frontend GameState)
- **Item body**: full `GameState` JSON + `email` string
- **Billing**: PAY_PER_REQUEST
- **Removal policy**: RETAIN (survives `cdk:destroy`)

---

## SES setup (required before OTP emails work)

1. AWS Console → SES → Verified identities → Create identity
2. Verify the sender email or domain (e.g. `pickleball@yourdomain.com`)
3. Set `SES_FROM_EMAIL` env var before deploying:
   ```bash
   SES_FROM_EMAIL=pickleball@yourdomain.com npm run cdk:deploy
   ```
4. In SES sandbox mode, recipient addresses must also be verified.
   Request production access via the SES console to lift the restriction.

---

## Stack outputs

After `cdk:deploy`, CDK prints:

| Output | Use |
|--------|-----|
| `ApiUrl` | Set as `VITE_API_URL` in `g2-app/.env` |
| `CloudFrontUrl` | Frontend URL |
| `UserPoolId` | Cognito User Pool ID (for reference) |
| `UserPoolClientId` | Cognito App Client ID (for reference) |
| `GamesTableName` | DynamoDB table name (for reference) |

---

## IAM permissions

- **Auth Lambdas**: `cognito-idp:InitiateAuth`, `RespondToAuthChallenge`, `AdminCreateUser`, `AdminGetUser`, `AdminUpdateUserAttributes`
- **Stats Lambdas**: DynamoDB read/write grants on `pickleball-games`
