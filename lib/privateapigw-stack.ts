import * as sns from '@aws-cdk/aws-sns';
import * as subs from '@aws-cdk/aws-sns-subscriptions';
import * as sqs from '@aws-cdk/aws-sqs';
import * as cdk from '@aws-cdk/core';
import * as apigw from '@aws-cdk/aws-apigateway';

export class PrivateapigwStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const api = new apigw.RestApi(this, 'testPrivateApiAWS');

    api.root.addMethod('ANY', new apigw.HttpIntegration('https://www.amazon.com/'));

    api.root.addProxy({
      anyMethod: true,
      defaultIntegration: new apigw.HttpIntegration(
        'https://www.amazon.com/{proxy}',
        {
          httpMethod: "GET",
          options: {
            requestParameters: {
              "integration.request.path.proxy": "method.request.path.proxy",
            },
          },
          proxy: true,
        },
      ),
      defaultMethodOptions: {
        methodResponses: [{ statusCode: "200" }],
        requestParameters: {
          "method.request.path.proxy": true,
        },
      },
    })

  }
}
