---
title: "Determining AWS IAM Policies According To Terraform And AWS CLI"
url: "https://meirg.co.il/2021/04/23/determining-aws-iam-policies-according-to-terraform-and-aws-cli/"
published: "2021-04-23"
tags: ["aws", "iam", "terraform", "hipaa"]
read_minutes: 9
author: "Meir Gabay"
source: "meirg.co.il"
---

# Determining AWS IAM Policies According To Terraform And AWS CLI

How to grant the **least privileges** required to execute
`aws s3 ls` and `terraform apply` from a CI/CD runner.

> If you're in health tech, this also helps you qualify HIPAA's
> **Minimum Necessary Requirement**.

## Scenario

You created a `cicd-user` IAM user with **AdministratorAccess**
and access keys, then wired them into your CI/CD service.
Common in early-stage startups: "we'll deal with permissions
later, we must focus on the product." Why? Because every time
CI/CD does something new, figuring out the minimum required
policies is a **nightmare**.

## The nightmare

The typical loop:

1. Create an IAM user with no permissions, generate access keys.
2. Run `aws ...` or `terraform ...`.
3. If it fails on authorization (403), the error message **may**
   tell you which permission is missing — usually one at a time.
4. Add it to the user's policy.
5. Repeat.

Sometimes you get a bare `Forbidden status code: 403`, which
tells you nothing about which permission is required.

## There's a tool for that — `iamlive`

[`iamlive`](https://github.com/iann0036/iamlive) by Ian Mckay:

> Generate an IAM policy from AWS calls using client-side
> monitoring (CSM) or embedded proxy.

We'll use **proxy mode**, which can run as a Docker container.

### How proxy mode works

`iamlive` runs in the background and serves on
`0.0.0.0:10080`. In a separate terminal you set:

- `HTTP_PROXY` and `HTTPS_PROXY` to point at iamlive
- `AWS_CA_BUNDLE` to iamlive's generated `ca.pem`

Now every `aws` and `terraform` call goes through iamlive, which
records the IAM actions invoked.

## Running `iamlive` in Docker

I built an image at `unfor19/iamlive-docker` that auto-publishes
to DockerHub from the `unfor19/iamlive-docker` GitHub repo.

**Terminal 1 — start iamlive-test:**

```bash
docker run \
  -p 80:10080 \
  -p 443:10080 \
  --name iamlive-test \
  -it unfor19/iamlive-docker \
    --mode proxy \
    --bind-addr 0.0.0.0:10080 \
    --force-wildcard-resource \
    --output-file "/app/iamlive.log"
# Average memory usage: 88MB
```

Key arguments:

- `-p 80:10080` and `-p 443:10080` map host ports 80/443 to the
  container's 10080.
- `--bind-addr 0.0.0.0:10080` — listen on any IP at port 10080.
- `--force-wildcard-resource` — easier to iterate over missing
  permissions.
- `--output-file "/app/iamlive.log"` — saves the latest IAM
  policy on `kill -HUP 1`.

## Configure CLIs to use the proxy

**Terminal 2 — set environment variables:**

```bash
export AWS_ACCESS_KEY_ID="AKIA_DUMMY_USER_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="DUMMY_USER_SECRET_ACCESS_KEY"

export HTTP_PROXY=http://127.0.0.1:80 \
       HTTPS_PROXY=http://127.0.0.1:443 \
       AWS_CA_BUNDLE="${HOME}/.iamlive/ca.pem"
```

`AWS_CA_BUNDLE` tells the AWS SDK to trust iamlive's generated
CA certificate. Copy it from the container:

```bash
docker cp iamlive-test:/home/appuser/.iamlive/ ~/
```

## Generating IAM policies

### `aws s3 ls`

```
$ aws s3 ls
An error occurred (AccessDenied) when calling the ListBuckets operation: Access Denied
```

But iamlive (Terminal 1) shows the **real** action name —
`s3:ListAllMyBuckets`, not `ListBuckets`:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:ListAllMyBuckets"],
    "Resource": "*"
  }]
}
```

### `terraform apply`

`terraform init` cannot be proxied through iamlive — it talks to
`registry.terraform.io`, which iamlive doesn't intercept. So
unset the proxy vars before running `terraform init`, then
re-export them before `terraform apply`.

After `terraform apply` against a tiny `aws_s3_bucket` resource,
iamlive captures:

```json
{
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "sts:GetCallerIdentity",
      "ec2:DescribeAccountAttributes",
      "s3:ListBucket"
    ],
    "Resource": "*"
  }]
}
```

Apply, see the next 403, repeat. After about **eight (8)
iterations** for a single `aws_s3_bucket`, the final policy
covers the full lifecycle — `s3:GetBucketAcl`, `GetBucketCORS`,
`GetBucketWebsite`, `GetBucketVersioning`,
`GetAccelerateConfiguration`, `GetBucketRequestPayment`,
`GetBucketLogging`, `GetLifecycleConfiguration`,
`GetReplicationConfiguration`, `GetEncryptionConfiguration`,
`GetBucketObjectLockConfiguration`, `GetBucketTagging`,
`CreateBucket`. **Always limit `"*"` to specific resources**
once the action list is stable.

## Stop and start without losing the CA

Omit `--rm` from `docker run` so iamlive's `ca.pem` survives
restarts:

```bash
docker stop iamlive-test
docker start -i iamlive-test
```

## Get the latest generated IAM policy

Send a `SIGHUP` to dump the latest output to `iamlive.log`:

```bash
docker exec iamlive-test kill -HUP 1 && \
  docker exec iamlive-test cat /app/iamlive.log | jq
```

## Stop using the proxy

```bash
unset HTTP_PROXY HTTPS_PROXY AWS_CA_BUNDLE
```

## Alternatives I considered

- **CloudTrail** — also a nightmare.
- **IAM Policy Simulator** — great for testing existing policies,
  not for generating them.
- **IAM Access Analyzer** — extended in April 2021 with new
  capabilities, still limited in service coverage.

## Final thoughts

The next step is wrapping this in a Bash script that runs
`terraform apply`, catches `403`, appends iamlive's output to
the IAM policy in AWS, retries. The copy-paste loop is annoying
but works.
