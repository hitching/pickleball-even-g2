"""
GET /stats (Cognito JWT required)

Returns all GameState[] for the authenticated user, ordered by startTime ascending.
userId comes from the JWT sub claim, extracted by API Gateway's JWT authorizer.
"""
import json
import os
import boto3
from boto3.dynamodb.conditions import Key

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
    if not user_id:
        return response(401, {"error": "Missing userId claim"})

    result = table.query(
        KeyConditionExpression=Key("userId").eq(user_id),
        ScanIndexForward=True,  # oldest first
    )

    games = [item["gameState"] for item in result.get("Items", [])]
    return response(200, games)
