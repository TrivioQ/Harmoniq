# Harmoniq on AWS (Terraform)

Deploys a production Harmoniq into an existing VPC:

| Component             | AWS service                                                                           |
| --------------------- | ------------------------------------------------------------------------------------- |
| Registry (N replicas) | ECS Fargate service, task role writes published manifests to S3                       |
| Dashboard             | ECS Fargate service                                                                   |
| Migrations            | One-off ECS task: `bootstrap-db.ts` (creates `harmoniq_app`), `prisma migrate deploy` |
| Routing               | ALB, HTTPS, host-based rules for `registry_domain` and `web_domain`                   |
| Database              | RDS Postgres 16 (encrypted, Multi-AZ by default, deletion protection)                 |
| Cache                 | ElastiCache Redis 7 (TLS), shared by all registry replicas                            |
| Published manifests   | Private S3 bucket + CloudFront (origin access control, CORS)                          |
| Secrets               | Secrets Manager: generated `JWT_SECRET`, `HARMONIQ_ENCRYPTION_KEY`, DB URLs           |

The two apps get separate hostnames because the dashboard has its own `/api/*` routes.

## Prerequisites

- A VPC with public subnets (ALB) and private subnets with NAT egress (image pulls, bundle validation, webhooks, GitHub sign-in).
- An ACM certificate in the same region covering both domains.
- Registry and dashboard images pushed to a registry ECS can pull from (built from `apps/registry/Dockerfile` and `apps/web/Dockerfile`).

## Usage

```hcl
module "harmoniq" {
  source = "github.com/your-org/harmoniq//deploy/terraform/aws"

  vpc_id             = "vpc-0123"
  public_subnet_ids  = ["subnet-a", "subnet-b"]
  private_subnet_ids = ["subnet-c", "subnet-d"]
  certificate_arn    = "arn:aws:acm:eu-west-1:123456789012:certificate/…"
  registry_domain    = "registry.acme.dev"
  web_domain         = "harmoniq.acme.dev"
  registry_image     = "ghcr.io/acme/harmoniq-registry:v1.0.0"
  web_image          = "ghcr.io/acme/harmoniq-web:v1.0.0"

  smtp_url = var.smtp_url # optional: email sign-in
}
```

Then:

1. `terraform apply`. The services start but fail health checks until the schema exists.
2. Run the migrate task (`terraform output -raw migrate_command | sh`) and wait for it to exit 0. Repeat this before every image upgrade.
3. Point both domains at `alb_dns_name` (Route 53 alias with `alb_zone_id`, or a CNAME).
4. Set `HARMONIQ_SETUP_TOKEN` for the first boot wizard (add it to the secret, or the task definition) and follow [Self-Hosting → First boot](../../../docs/self-hosting.md#3-first-boot).
5. Give host apps the CDN base URL (`terraform output manifest_cdn_url`) as the SDK's `cdnBaseUrl`.

For GitHub sign-in, set `github_client_id` / `github_client_secret` and use `https://<web_domain>/api/auth/callback/github` as the callback URL.

## Notes

- **TLS to Postgres.** URLs use `sslmode=require`. pg-boss (node-pg) treats that as full verification, so the registry and migrate tasks download the [RDS CA bundle](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html) at start and set `NODE_EXTRA_CA_CERTS`. If your tasks can't reach `truststore.pki.rds.amazonaws.com`, bake the bundle into the image instead.
- **Secrets.** Terraform generates them and keeps them in state; use an encrypted remote backend. Back up `HARMONIQ_ENCRYPTION_KEY` (from the Secrets Manager entry): losing it makes stored storage credentials and webhook secrets unreadable.
- **Replicas.** `registry_count` can be raised freely: the cache and rate limits live in Redis, and publish jobs are deduplicated in Postgres.
- **Deletion.** RDS has deletion protection and takes a final snapshot; disable protection first if you really mean to destroy it.
- Not included: WAF, Route 53 records, autoscaling policies, a bastion. Add them around the module as your account requires.

## Outputs

| Output             | Description                                      |
| ------------------ | ------------------------------------------------ |
| `alb_dns_name`     | Target for both DNS records                      |
| `alb_zone_id`      | For Route 53 alias records                       |
| `manifest_cdn_url` | SDK `cdnBaseUrl`                                 |
| `manifest_bucket`  | Bucket holding published manifests               |
| `cluster_name`     | ECS cluster                                      |
| `migrate_command`  | `aws ecs run-task …` for the migrate task        |
| `secret_arn`       | Secrets Manager entry with the generated secrets |
