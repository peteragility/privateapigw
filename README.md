## Custom Domain Solution for Private Amazon API Gateway

Amazon API Gateway provides custom domain support for public API, which you can call the API using your own domain and TLS certificate. But custom domain does not support private API Gateway, which make it impossible for customer to call private API over VPN / Direct Connect using custom domain and TLS certificate. This solution aims to solve this issue.

## The Architecture

![](https://raw.githubusercontent.com/peterone928/privateapigw/master/images/apigw-private-custom-domain.jpg)

## To deploy the sample stack

This repo is a AWS CDK stack to deploy the architecture above into your AWS account, and let you test the solution for custom domain support for Private API Gateway. Ensure you've installed AWS CLI and AWS CDK in your workstation before proceed:

- Git clone this repo.
- Decide the custom domain to use and generate a TLS cert for it, you can generate a self signed cert by:
  ```
  openssl
  genrsa -out Private.key 2048
  req -new -x509 -key Private.key -out Certificate.crt -days 365
  ```
- Import the TLS cert to AWS Certificate Manager (ACM) by:
   ```
   aws acm import-certificate --certificate fileb://Certificate.crt --private-key fileb://Private.key
   ```
- Modify the cdk.json file, replace the "myCertArn" parameter value with ACM imported cert ARN, and "myDomain" with the custom domain.
- Goto root directory of repo, run:
  ```
  npm install
  npm run build
  cdk deploy
  ```
- Spin up an testing EC2 in testing VPC, SSH to it and run the following command to test the private api using custom domain (for example, myapitest.com):
   ```
   curl https://myapitest.com --insecure
   ```