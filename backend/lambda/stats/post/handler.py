"""
POST /stats (Cognito JWT required)

Stores a completed GameState for the authenticated user.
PK: userId (Cognito sub), SK: startTime (ISO 8601 from gameStartTime ms epoch).
"""
import json
import os
from datetime import datetime, timezone
import boto3

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ["TABLE_NAME"])


def response(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def handler(event, context):
    claims = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})
    user_id = claims.get("sub")
    email = claims.get("email", "")
    if not user_id:
        return response(401, {"error": "Missing userId claim"})

    try:
        game_state = json.loads(event.get("body") or "{}")
        game_start_ms = game_state.get("gameStartTime")
        if not game_start_ms:
            raise ValueError("missing gameStartTime")
    except Exception:
        return response(400, {"error": "Invalid GameState body"})

    start_time = datetime.fromtimestamp(game_start_ms / 1000, tz=timezone.utc).isoformat()

    table.put_item(Item={
        "userId": user_id,
        "startTime": start_time,
        "email": email,
        "gameState": game_state,
    })

    return response(200, {"ok": True})
