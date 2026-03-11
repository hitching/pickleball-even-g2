"""
POST /auth/verify { email, code, session }

Submits the OTP to Cognito via RespondToAuthChallenge with EMAIL_OTP.
Returns { token } — the Cognito IdToken (JWT) on success.
"""
import json
import os
import boto3
from botocore.exceptions import ClientError

cognito = boto3.client("cognito-idp")
CLIENT_ID = os.environ["CLIENT_ID"]


def response(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def handler(event, context):
    try:
        body = json.loads(event.get("body") or "{}")
        email = body.get("email", "").strip().lower()
        code = body.get("code", "").strip()
        session = body.get("session", "").strip()
        if not email or not code or not session:
            raise ValueError("missing fields")
    except Exception:
        return response(400, {"error": "Invalid request body — expected { email, code, session }"})

    try:
        result = cognito.respond_to_auth_challenge(
            ClientId=CLIENT_ID,
            ChallengeName="EMAIL_OTP",
            Session=session,
            ChallengeResponses={"USERNAME": email, "EMAIL_OTP_CODE": code},
        )
    except ClientError as e:
        code_name = e.response["Error"]["Code"]
        if code_name in ("NotAuthorizedException", "CodeMismatchException"):
            return response(401, {"error": "Invalid or expired code"})
        raise

    auth_result = result.get("AuthenticationResult", {})
    id_token = auth_result.get("IdToken")
    if not id_token:
        return response(401, {"error": "Authentication failed"})

    refresh_token = auth_result.get("RefreshToken")
    return response(200, {"token": id_token, "refreshToken": refresh_token})
