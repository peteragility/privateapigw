import { 
  App, 
  Stack, 
  StackProps
} from 'aws-cdk-lib';
import { Construct } from "constructs";
import { aws_apigateway as apigw } from 'aws-cdk-lib';
import { aws_ec2 as ec2} from 'aws-cdk-lib';
import { aws_iam as iam} from 'aws-cdk-lib';
import {
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
} from "aws-cdk-lib/aws-ec2";
import { 
  ListenerCertificate,
  NetworkLoadBalancer,
  NetworkTargetGroup,
  Protocol,
  TargetType,
 } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { IpTarget } from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from "aws-cdk-lib/custom-resources";
import { Token } from 'aws-cdk-lib/core';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { SecurityPolicy } from 'aws-cdk-lib/aws-apigateway';
import {
  ARecord,
  PrivateHostedZone,
  RecordTarget,
} from 'aws-cdk-lib/aws-route53';
import { LoadBalancerTarget } from 'aws-cdk-lib/aws-route53-targets';
import { 
  Code,
  Function,
  Runtime,
 } from 'aws-cdk-lib/aws-lambda';


export class PrivateapigwStack extends Stack {
  constructor(scope: App, id: string, props?: StackProps) {
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
        subnetType: SubnetType.PRIVATE_ISOLATED
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
      runtime: Runtime.NODEJS_14_X,
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

  }
}
