import * as cdk from '@aws-cdk/core';
import * as apigw from '@aws-cdk/aws-apigateway';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as iam from '@aws-cdk/aws-iam';
import { Peer, Port, SecurityGroup, SubnetType } from '@aws-cdk/aws-ec2';
import { IpTarget, ListenerCertificate, NetworkLoadBalancer, NetworkTargetGroup, Protocol, TargetType } from '@aws-cdk/aws-elasticloadbalancingv2';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from '@aws-cdk/custom-resources';
import { Token } from '@aws-cdk/core';
import { Certificate } from '@aws-cdk/aws-certificatemanager';
import { SecurityPolicy } from '@aws-cdk/aws-apigateway';
import { ARecord, PrivateHostedZone, RecordTarget } from '@aws-cdk/aws-route53';
import { LoadBalancerTarget } from '@aws-cdk/aws-route53-targets';
import { Code, Function, Runtime } from '@aws-cdk/aws-lambda';

export class PrivateapigwStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Set domain and imported ACM cert ARN
    const myDomain = this.node.tryGetContext('myDomain');
    const myCertArn = this.node.tryGetContext('myCertArn');

    // Setup source VPC
    const myVpc = new ec2.Vpc(this, 'myVpc', {
      maxAzs: 2,
      cidr: '10.0.0.0/16',
      subnetConfiguration: [{
        name: 'isolated',
        subnetType: SubnetType.ISOLATED
      }]
    })

    // Setup test VPC
    const testVpc = new ec2.Vpc(this, 'testVpc', {
      maxAzs: 1,
      cidr: '196.168.0.0/16'
    })

    // Setup VPC peering and related routes between source VPC and test VPC
    const peeringConn = new ec2.CfnVPCPeeringConnection(this, 'myPeeringConn', {
      vpcId: myVpc.vpcId,
      peerVpcId: testVpc.vpcId
    });

    myVpc.isolatedSubnets.forEach(({ routeTable: { routeTableId } }, index) => {
      new ec2.CfnRoute(this, 'myVpcPeeringRoute' + index, {
        destinationCidrBlock: testVpc.vpcCidrBlock,
        routeTableId,
        vpcPeeringConnectionId: peeringConn.ref,
      })
    });

    testVpc.privateSubnets.forEach(({ routeTable: { routeTableId } }, index) => {
      new ec2.CfnRoute(this, 'testVpcPeeringRoute' + index, {
        destinationCidrBlock: myVpc.vpcCidrBlock,
        routeTableId,
        vpcPeeringConnectionId: peeringConn.ref,
      })
    });

    // Setup VPC Interface Endpoint for API Gateway
    const myApiGwVpceSG = new SecurityGroup(this, 'myApiGwVpceSG', {
      vpc: myVpc
    });
    myApiGwVpceSG.addIngressRule(Peer.ipv4(myVpc.vpcCidrBlock), Port.tcp(443));
    myApiGwVpceSG.addIngressRule(Peer.ipv4(testVpc.vpcCidrBlock), Port.tcp(443));

    const myEndpoint = new ec2.InterfaceVpcEndpoint(this, 'myEndpoint', {
      vpc: myVpc,
      service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
      privateDnsEnabled: true,
      securityGroups: [myApiGwVpceSG]
    });

    // Setup Network Load Balancer to point to the interface endpoint IPs started
    const myTargetGroup = new NetworkTargetGroup(this, 'myApiTargetGroup', {
      port: 443,
      targetType: TargetType.IP,
      protocol: Protocol.TLS,
      vpc: myVpc
    })

    const myEndpointIps = new AwsCustomResource(this, `myEndpointIps`, {
      onUpdate: {
        service: 'EC2',
        action: 'describeNetworkInterfaces',
        parameters: {
          NetworkInterfaceIds: myEndpoint.vpcEndpointNetworkInterfaceIds
        },
        physicalResourceId: PhysicalResourceId.of(Date.now().toString())
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: AwsCustomResourcePolicy.ANY_RESOURCE })
    });

    for (let index = 0; index < myVpc.availabilityZones.length; index++) {
      myTargetGroup.addTarget(new IpTarget(Token.asString(
          myEndpointIps.getResponseField(`NetworkInterfaces.${index}.PrivateIpAddress`))));
    }

    const myNlb = new NetworkLoadBalancer(this, 'myNlbForApi', {
      crossZoneEnabled: true,
      vpc: myVpc
    });
    
    myNlb.addListener('myNlbTlsListener', {
      port: 443,
      protocol: Protocol.TLS,
      certificates: [ListenerCertificate.fromArn(myCertArn)],
      defaultTargetGroups: [myTargetGroup]
    });
    // Setup Network Load Balancer to point to the interface endpoint IPs ended

    // Setup Route53 Private Zone to point domain name to private api gateway
    const myHostedZone = new PrivateHostedZone(this, 'myHostedZone', {
      vpc: testVpc,
      zoneName: myDomain
    });

    new ARecord(this, 'R53Record', {
      recordName: myDomain,
      zone: myHostedZone,
      target: RecordTarget.fromAlias(new LoadBalancerTarget(myNlb))
    })

    // Setup resource policy for api gateway
    const myPolicyDocument = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          actions: ['execute-api:Invoke'],
          effect: iam.Effect.ALLOW,
          resources: ['execute-api:/*'],
          principals: [new iam.AnyPrincipal],
          conditions: {
            'IpAddress': {
              'aws:VpcSourceIp': [myVpc.vpcCidrBlock, testVpc.vpcCidrBlock]
            }
          }
        })
      ]
    });

    // The api gateway with lambda hello world backend
    const lambdaBackend = new Function(this, 'lambdaBackend', {
      runtime: Runtime.NODEJS_12_X,
      handler: 'app.lambdaHandler',
      code: Code.fromAsset('lambda')
    });

    // Setup private Restful API, specify the vpc endpoint created above
    const myApi = new apigw.LambdaRestApi(this, 'testPrivateApiAWS', {
      endpointConfiguration: {
        types: [apigw.EndpointType.PRIVATE],
        vpcEndpoints: [myEndpoint]
      },
      policy: myPolicyDocument,
      domainName: {
        domainName: myDomain,
        certificate: Certificate.fromCertificateArn(this, 'myCert', myCertArn),
        securityPolicy: SecurityPolicy.TLS_1_2
      },
      handler: lambdaBackend
    });

    // The api gateway simply proxy all reqeusts to amazon.com started
    /*
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
    });
    */
    // The api gateway simply proxy all reqeusts to amazon.com ended

  }
}
