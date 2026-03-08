# backend — AWS CDK (TypeScript)

Pickleball G2 backend: Cognito email OTP auth, API Gateway, Lambda, DynamoDB. Region: `us-east-1`.

## Prerequisites

1. AWS CLI configured (`aws configure` or `AWS_PROFILE` set)
2. CDK bootstrapped: `npx cdk bootstrap aws://ACCOUNT/us-east-1`
3. SES sender verified in AWS console (see SES section below)
4. Install deps: `npm install`

## Commands

```bash
npm run cdk:synth    # synthesise CloudFormation — no AWS calls
npm run cdk:diff     # show what will change
npm run cdk:deploy   # deploy to AWS (us-east-1 by default)
npm run cdk:destroy  # tear down stack (DynamoDB and User Pool are RETAIN)
```

## Stack resources

| Resource | Name/ID | Notes |
|----------|---------|-------|
| DynamoDB | `pickleball-games` | PK: userId, SK: startTime (ISO 8601) |
| Cognito User Pool | `pickleball-users` | email username, no password |
| Cognito App Client | `pickleball-app` | ALLOW_CUSTOM_AUTH, no secret |
| HTTP API | `pickleball-api` | CORS open; routes below |
| Lambda ×7 | see lambda/ | Bundled with esbuild via NodejsFunction |

## API routes

| Method | Path | Auth | Lambda |
|--------|------|------|--------|
| POST | /auth/send-code | none | lambda/auth/send-code |
| POST | /auth/verify | none | lambda/auth/verify-code |
| GET | /stats | Cognito JWT | lambda/stats/get |
| POST | /stats | Cognito JWT | lambda/stats/post |

## SES setup (required before OTP emails work)

1. AWS Console → SES → Verified identities → Create identity
2. Verify the sender email or domain (e.g. `pickleball@yourdomain.com`)
3. Set `SES_FROM_EMAIL` env var before deploying:
   ```bash
   SES_FROM_EMAIL=pickleball@yourdomain.com npm run cdk:deploy
   ```
4. In sandbox mode, recipient addresses must also be verified.
   Request production access via SES console to lift the sandbox.

## Stack outputs (used in g2-app/.env)

After deploy, CDK prints:
- `ApiUrl` → set as `VITE_API_URL` in `g2-app/.env`
- `UserPoolId`, `UserPoolClientId` — for reference

## Lambda structure

```
lambda/
  auth/
    send-code/index.ts    POST /auth/send-code — InitiateAuth(CUSTOM_AUTH)
    verify-code/index.ts  POST /auth/verify    — RespondToAuthChallenge → IdToken
  stats/
    get/index.ts          GET  /stats          — query DynamoDB by userId
    post/index.ts         POST /stats          — put GameState in DynamoDB
  cognito-triggers/
    define-auth/index.ts  DefineAuthChallenge trigger
    create-auth/index.ts  CreateAuthChallenge — generates OTP, sends via SES
    verify-auth/index.ts  VerifyAuthChallenge — compares submitted code
```
