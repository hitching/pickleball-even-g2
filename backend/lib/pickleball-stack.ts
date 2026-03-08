import * as cdk from 'aws-cdk-lib'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2'
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import * as apigatewayv2Authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers'
import { Construct } from 'constructs'
import * as path from 'path'

const PYTHON = lambda.Runtime.PYTHON_3_13

export class PickleballStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    // -------------------------------------------------------------------------
    // DynamoDB — pickleball-games
    // PK: userId (Cognito sub), SK: startTime (ISO 8601)
    // -------------------------------------------------------------------------

    const gamesTable = new dynamodb.Table(this, 'GamesTable', {
      tableName: 'pickleball-games',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'startTime', type: dynamodb.AttributeType.STRING },
      billingMode:  dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    const pyFn = (id: string, dir: string, env?: Record<string, string>) =>
      new lambda.Function(this, id, {
        runtime: PYTHON,
        code: lambda.Code.fromAsset(path.join(__dirname, '../lambda', dir)),
        handler: 'handler.handler',
        environment: env,
      })

    // -------------------------------------------------------------------------
    // Cognito User Pool — email username, USER_AUTH + EMAIL_OTP (no SES needed)
    // Cognito sends the OTP itself via its managed email infrastructure.
    // -------------------------------------------------------------------------

    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'pickleball-users',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.NONE,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool,
      userPoolClientName: 'pickleball-app',
      generateSecret: false,
    })

    // ALLOW_USER_AUTH (EMAIL_OTP flow) isn't in CDK L2 types yet — set via L1 escape hatch
    const cfnClient = userPoolClient.node.defaultChild as cognito.CfnUserPoolClient
    cfnClient.explicitAuthFlows = ['ALLOW_USER_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH']

    // Enable EMAIL_OTP as a first-factor sign-in method — required for USER_AUTH + EMAIL_OTP
    // CDK L2 doesn't expose signInPolicy yet — use L1 escape hatch
    const cfnUserPool = userPool.node.defaultChild as cognito.CfnUserPool
    cfnUserPool.policies = {
      signInPolicy: {
        allowedFirstAuthFactors: ['EMAIL_OTP', 'PASSWORD'], // PASSWORD is mandatory per Cognito API
      },
    }

    // -------------------------------------------------------------------------
    // Auth Lambdas — thin wrappers that call Cognito SDK
    // -------------------------------------------------------------------------

    const sharedAuthEnv = {
      USER_POOL_ID:  userPool.userPoolId,
      CLIENT_ID:     userPoolClient.userPoolClientId,
    }

    const sendCodeFn  = pyFn('SendCodeFn',  'auth/send-code',  sharedAuthEnv)
    const verifyCodeFn = pyFn('VerifyCodeFn', 'auth/verify-code', sharedAuthEnv)

    // sendCode needs cognito:InitiateAuth, verifyCode needs cognito:RespondToAuthChallenge
    const cognitoAuthPolicy = new iam.PolicyStatement({
      actions: [
        'cognito-idp:InitiateAuth',
        'cognito-idp:RespondToAuthChallenge',
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminGetUser',
        'cognito-idp:AdminUpdateUserAttributes',
      ],
      resources: [userPool.userPoolArn],
    })
    sendCodeFn.addToRolePolicy(cognitoAuthPolicy)
    verifyCodeFn.addToRolePolicy(cognitoAuthPolicy)

    // -------------------------------------------------------------------------
    // Stats Lambdas
    // -------------------------------------------------------------------------

    const getStatsFn  = pyFn('GetStatsFn',  'stats/get',  { TABLE_NAME: gamesTable.tableName })
    const postStatsFn = pyFn('PostStatsFn', 'stats/post', { TABLE_NAME: gamesTable.tableName })

    gamesTable.grantReadData(getStatsFn)
    gamesTable.grantWriteData(postStatsFn)

    // -------------------------------------------------------------------------
    // HTTP API Gateway
    // -------------------------------------------------------------------------

    const httpApi = new apigatewayv2.HttpApi(this, 'HttpApi', {
      apiName: 'pickleball-api',
      corsPreflight: {
        allowHeaders: ['Content-Type', 'Authorization'],
        allowMethods: [
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: ['*'],
      },
    })

    const jwtAuthorizer = new apigatewayv2Authorizers.HttpJwtAuthorizer(
      'CognitoJwtAuthorizer',
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      {
        jwtAudience: [userPoolClient.userPoolClientId],
      },
    )

    // Public auth routes
    httpApi.addRoutes({
      path: '/auth/send-code',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('SendCodeIntegration', sendCodeFn),
    })

    httpApi.addRoutes({
      path: '/auth/verify',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('VerifyCodeIntegration', verifyCodeFn),
    })

    // Protected stats routes
    httpApi.addRoutes({
      path: '/stats',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('GetStatsIntegration', getStatsFn),
      authorizer: jwtAuthorizer,
    })

    httpApi.addRoutes({
      path: '/stats',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('PostStatsIntegration', postStatsFn),
      authorizer: jwtAuthorizer,
    })

    // -------------------------------------------------------------------------
    // Stack outputs
    // -------------------------------------------------------------------------

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: httpApi.apiEndpoint,
      description: 'Set as VITE_API_URL in g2-app/.env',
    })

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
    })

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
    })

    new cdk.CfnOutput(this, 'GamesTableName', {
      value: gamesTable.tableName,
    })
  }
}
