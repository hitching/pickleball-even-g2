import * as cdk from 'aws-cdk-lib'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2'
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import * as apigatewayv2Authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers'
import * as s3         from 'aws-cdk-lib/aws-s3'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins    from 'aws-cdk-lib/aws-cloudfront-origins'
import * as s3deploy   from 'aws-cdk-lib/aws-s3-deployment'
import * as acm        from 'aws-cdk-lib/aws-certificatemanager'
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
    // RefreshToken valid for 90 days; IdToken valid for 24h (AWS maximum for IdToken)
    cfnClient.refreshTokenValidity = 90
    cfnClient.idTokenValidity = 1440   // minutes = 24h
    cfnClient.tokenValidityUnits = { refreshToken: 'days', idToken: 'minutes' }

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

    const sendCodeFn   = pyFn('SendCodeFn',   'auth/send-code',   sharedAuthEnv)
    const verifyCodeFn = pyFn('VerifyCodeFn', 'auth/verify-code', sharedAuthEnv)
    const refreshFn    = pyFn('RefreshFn',    'auth/refresh',     sharedAuthEnv)

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
    refreshFn.addToRolePolicy(cognitoAuthPolicy)

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

    httpApi.addRoutes({
      path: '/auth/refresh',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('RefreshIntegration', refreshFn),
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
    // ACM Certificates — DNS validation (non-blocking: attach in next deploy)
    // -------------------------------------------------------------------------

    const frontendCert = new acm.CfnCertificate(this, 'FrontendCert', {
      domainName:       'pickleball.hitching.net',
      validationMethod: 'DNS',
    })

    const apiCert = new acm.CfnCertificate(this, 'ApiCert', {
      domainName:       'pickleball-api.hitching.net',
      validationMethod: 'DNS',
    })

    // -------------------------------------------------------------------------
    // S3 — private bucket for static site assets
    // -------------------------------------------------------------------------

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy:     cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL:        true,
    })

    // -------------------------------------------------------------------------
    // CloudFront — OAC distribution, SPA fallback, HTTPS-only
    // -------------------------------------------------------------------------

    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      defaultBehavior: {
        origin:         origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods:  cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy:    cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.seconds(0) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.seconds(0) },
      ],
      priceClass:  cloudfront.PriceClass.PRICE_CLASS_100,
      domainNames: ['pickleball.hitching.net'],
      certificate: acm.Certificate.fromCertificateArn(this, 'FrontendCertRef', frontendCert.ref),
    })

    // -------------------------------------------------------------------------
    // BucketDeployment — sync dist/ to S3 + invalidate CloudFront on deploy
    // -------------------------------------------------------------------------

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources:           [s3deploy.Source.asset(path.join(__dirname, '../../g2-app/dist'))],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/index.html'],
    })

    // -------------------------------------------------------------------------
    // API Gateway custom domain — pickleball-api.hitching.net
    // -------------------------------------------------------------------------

    const apiDomain = new apigatewayv2.DomainName(this, 'ApiDomain', {
      domainName:  'pickleball-api.hitching.net',
      certificate: acm.Certificate.fromCertificateArn(this, 'ApiCertRef', apiCert.ref),
    })

    new apigatewayv2.ApiMapping(this, 'ApiMapping', {
      api:        httpApi,
      domainName: apiDomain,
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

    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      value:       `https://${distribution.distributionDomainName}`,
      description: 'CloudFront URL for the React app',
    })

    new cdk.CfnOutput(this, 'FrontendCertArn', {
      value:       frontendCert.ref,
      description: 'ACM cert for pickleball.hitching.net — attach to CloudFront after validation',
    })

    new cdk.CfnOutput(this, 'ApiCertArn', {
      value:       apiCert.ref,
      description: 'ACM cert for pickleball-api.hitching.net — attach to API Gateway after validation',
    })

    new cdk.CfnOutput(this, 'ApiDomainTarget', {
      value:       apiDomain.regionalDomainName,
      description: 'Point pickleball-api.hitching.net CNAME here',
    })
  }
}
