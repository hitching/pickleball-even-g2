"""
POST /auth/send-code { email }

Ensures the user exists in the Cognito User Pool (creates them silently if not),
then initiates USER_AUTH with PREFERRED_CHALLENGE=EMAIL_OTP.
Cognito sends the OTP to the user's email itself — no SES required.
Returns { session } — the caller must echo this back in /auth/verify.
"""
import json
import os
import boto3
from botocore.exceptions import ClientError

cognito = boto3.client("cognito-idp")
USER_POOL_ID = os.environ["USER_POOL_ID"]
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
        if not email:
            raise ValueError("missing email")
    except Exception:
        return response(400, {"error": "Invalid request body — expected { email }"})

    # Ensure user exists; create silently if not
    try:
        cognito.admin_get_user(UserPoolId=USER_POOL_ID, Username=email)
    except ClientError as e:
        if e.response["Error"]["Code"] == "UserNotFoundException":
            cognito.admin_create_user(
                UserPoolId=USER_POOL_ID,
                Username=email,
                UserAttributes=[
                    {"Name": "email", "Value": email},
                    {"Name": "email_verified", "Value": "true"},
                ],
                MessageAction="SUPPRESS",
            )
        else:
            raise

    result = cognito.initiate_auth(
        AuthFlow="USER_AUTH",
        ClientId=CLIENT_ID,
        AuthParameters={
            "USERNAME": email,
            "PREFERRED_CHALLENGE": "EMAIL_OTP",
        },
    )

    return response(200, {"session": result["Session"]})
