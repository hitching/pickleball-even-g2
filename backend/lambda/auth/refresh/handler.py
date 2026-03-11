"""
POST /auth/refresh { refreshToken }

Exchanges a Cognito RefreshToken for a new IdToken.
Returns { token } — a fresh Cognito IdToken (JWT) on success.
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
        refresh_token = body.get("refreshToken", "").strip()
        if not refresh_token:
            raise ValueError("missing refreshToken")
    except Exception:
        return response(400, {"error": "Invalid request body — expected { refreshToken }"})

    try:
        result = cognito.initiate_auth(
            AuthFlow="REFRESH_TOKEN_AUTH",
            AuthParameters={"REFRESH_TOKEN": refresh_token},
            ClientId=CLIENT_ID,
        )
    except ClientError as e:
        code_name = e.response["Error"]["Code"]
        if code_name in ("NotAuthorizedException", "UserNotFoundException"):
            return response(401, {"error": "Refresh token invalid or expired"})
        raise

    id_token = result.get("AuthenticationResult", {}).get("IdToken")
    if not id_token:
        return response(401, {"error": "Token refresh failed"})

    return response(200, {"token": id_token})
