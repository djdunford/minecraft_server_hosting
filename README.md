# Satisfactory Server Hosting

Infrastructure and admin tooling for running a self-hosted [Satisfactory](https://www.satisfactorygame.com/) dedicated server on a low-cost AWS EC2 spot instance, with a web portal to start/stop the server and point DNS at it on demand.

## Architecture

Deployed via AWS SAM (`template.yaml`) into a single CloudFormation stack:

- **EC2 instance** — a persistent spot instance (`t3.2xlarge`) running the Satisfactory dedicated server, in its own VPC/public subnet. Spot interruptions stop rather than terminate the instance.
- **Admin portal** — a static site (`portal/index.html`) served from S3 via CloudFront, protected by Cognito sign-in.
- **Server control API** — an HTTP API (API Gateway) backed by a Lambda (`server-control/app.ts`) that exposes:
  - `GET /status` — current instance state, public IP, and (when running) the number of online players and player limit, queried live from the Satisfactory Dedicated Server's [HTTPS API](https://satisfactory.wiki.gg/wiki/Dedicated_servers/HTTPS_API) (`QueryServerState`)
  - `POST /start` — start the instance
  - `POST /stop` — stop the instance
  - `POST /update-dns` — upsert a Route 53 `A` record for the server's domain to the instance's current public IP
- **Automatic backups** — a second Lambda (`server-control/image.ts`) is triggered by EventBridge whenever the instance transitions to `stopped` (including spot interruptions) and creates an AMI named `Satisfactory-<YYYYMMDDHHMM>`, tagged the same way, as a point-in-time backup of the server's save data.
- **DNS** — a Route 53 hosted zone provides both the portal's domain (aliased to CloudFront) and the server's domain (updated on demand via the API).

Every API request is authenticated via Cognito, and the authenticated user's `sub`/`email` are attached to structured JSON logs emitted by both Lambdas for auditing.

## Prerequisites

- AWS account and credentials configured locally
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- Node.js 24+ (for local testing of the Lambda code)
- A Route 53 hosted zone for your domain
- An ACM certificate for the portal domain, **issued in `us-east-1`** (required for CloudFront)

## Deploying the stack

```bash
sam build
sam deploy --guided
```

Key parameters (see `Parameters` in `template.yaml`):

| Parameter | Description | Default |
|---|---|---|
| `VpcCIDR` | CIDR block for the VPC | `10.192.0.0/16` |
| `PublicSubnet1CIDR` | CIDR block for the public subnet | `10.192.10.0/24` |
| `PortalCertificateArn` | ACM cert ARN for the portal domain (us-east-1) | — |
| `PortalDomainName` | Domain the admin portal is served from | `portal.fivearcher.co.uk` |
| `HostedZoneId` | Route 53 hosted zone ID | `Z05196342OPHB8ROH3JXW` |
| `ServerDomainName` | Domain pointing at the server's public IP | `sat.fivearcher.co.uk` |
| `DnsTtl` | TTL (seconds) for the server DNS record | `5` |

A `samconfig.toml` is included with defaults for repeat deploys (`sam deploy` without `--guided`).

After deploying, note the stack outputs — `PortalUrl`, `ApiUrl`, `CognitoUserPoolId`, `CognitoClientId` — and:

1. Create a Cognito user in the created user pool (via the console or `aws cognito-idp admin-create-user`) for anyone who should have access to the portal.
2. Update the `CONFIG` object at the top of the `<script>` block in `portal/index.html` with the `userPoolId`, `clientId`, and `apiUrl` outputs.
3. Sync `portal/index.html` to the `PortalBucket` (e.g. `aws s3 cp portal/index.html s3://<bucket>/index.html`) and invalidate the CloudFront distribution if needed.

## Using the portal

Sign in at `PortalUrl` with a Cognito user's credentials (first login requires setting a new password). From there you can:

- Start the server and wait for it to report a public IP
- Point `ServerDomainName` at that IP
- See the number of players currently online once the server is running (see [Configuring the Satisfactory API token](#configuring-the-satisfactory-api-token-for-online-player-count) if this is required by your server)
- Stop the server — a backup AMI is created automatically once it reaches the `stopped` state

## Server-control Lambda development

```bash
cd server-control
npm install
npm test    # tsc + jest, with coverage
npm run lint
```

Tests live in `server-control/tests/unit`.

## Setting up the Satisfactory server on EC2

Install steamcmd and the dedicated server:

```bash
sudo add-apt-repository multiverse; sudo dpkg --add-architecture i386; sudo apt update
sudo apt install steamcmd -y
steamcmd +force_install_dir ~/SatisfactoryDedicatedServer +login anonymous +app_update 1690800 validate +quit
cd SatisfactoryDedicatedServer/
./FactoryServer.sh
```

Keep the instance's packages up to date:

```bash
sudo apt -y update
sudo apt -y upgrade
```

## Configuring the Satisfactory API token (for online player count)

The `/status` endpoint calls the Satisfactory Dedicated Server's [HTTPS API](https://satisfactory.wiki.gg/wiki/Dedicated_servers/HTTPS_API) (`QueryServerState`, port 7777) to report the number of online players. Some server configurations require a Bearer token for this call; the token is stored in AWS Systems Manager Parameter Store rather than a Lambda environment variable, so it can be rotated without a redeploy.

To generate a long-lived token, run the following in the Satisfactory dedicated server console:

```
server.GenerateAPIToken
```

Then store it as a `SecureString` parameter (via the AWS Console, or the CLI) at the path the stack expects — `/<stack-name>/satisfactory/api-token`, e.g.:

```bash
aws ssm put-parameter \
  --name "/satisfactory-server-2/satisfactory/api-token" \
  --type SecureString \
  --value "<token>" \
  --overwrite
```

If the parameter doesn't exist or can't be read, `/status` still succeeds — it just omits the `Authorization` header on the game API call and reports `onlinePlayers`/`playerLimit` as `null`, logging a warning.

## Restoring from a backup AMI

Each stop of the server produces an AMI named `Satisfactory-<YYYYMMDDHHMM>`. To restore, launch a new instance from the desired AMI (or update the `EC2Instance` resource's `ImageId` in `template.yaml` and redeploy) — the save data on the root volume will be restored along with it.
