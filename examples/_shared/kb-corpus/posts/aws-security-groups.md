---
title: "AWS Security Groups - Once And For All"
url: "https://meirg.co.il/2021/06/02/aws-security-groups-once-and-for-all/"
published: "2021-06-02"
tags: ["aws", "network", "security", "hipaa"]
read_minutes: 4
author: "Meir Gabay"
source: "meirg.co.il"
---

# AWS Security Groups — Once And For All

Securing applications in the cloud means setting proper network
rules: maximum security, minimum collateral damage. From the
HIPAA technical safeguards: *"A covered entity must implement
technical security measures that guard against unauthorized
access to e-PHI that is being transmitted over an electronic
network."*

## Network security layers in AWS

There's a layer cake of network security. The most common in AWS:

1. **Application** — AWS Web Application Firewall (WAF)
2. **Subnet** — AWS Network Access Lists (NACLs)
3. **Virtual Firewall** — AWS Security Groups
4. **Network** — AWS Network Firewall

This post focuses on the Virtual Firewall layer — Security
Groups.

## Stateful vs. stateless

Security Groups are **stateful**. From the AWS docs:

> If you send a request from your instance, the response traffic
> for that request is allowed to flow in regardless of inbound
> security group rules. Responses to allowed inbound traffic are
> allowed to flow out, regardless of outbound rules.

By default, a security group is created with **no inbound
rules** (rejects all new connections initiated from outside) and
a **default outbound rule of `0.0.0.0/0`** (allows the instance
to initiate outbound to anywhere).

Once a connection is initiated, the SG rule is ignored for that
connection.

NACLs are the **stateless** layer (covered below).

## Security Group ground rules

1. **Once a connection is initiated, the security group rules
   are ignored** for that connection. New traffic on that
   connection flows.
2. **There's no way to enforce SG rules on existing
   connections.** Rules apply to new connections only. To force
   new SG rules, you must terminate existing connections.

## Practical example

You want to SSH from your local machine to an EC2 instance with
a public IP.

1. Add an inbound rule allowing `SSH` from `My IP`.
2. SSH in. It works.
3. Someone removes your inbound rule **during** your SSH session.
   **Nothing happens** — your SSH session stays alive. Rules
   apply to new connections only.
4. If you disconnect for even a split second, the new rule
   takes effect and you can't reconnect.

## Allow or deny?

Security Groups are designed to **allow** access from/to sources
and implicitly block unknown ones. **There is no Deny option** on
SG rules. When you add a rule, the only choice is Allow.

### Blocking specific IPs

Use **NACLs** instead. NACLs operate at the **subnet level**
(SGs operate at the VPC level), are **stateless**, and let you
explicitly Allow or Deny. Because they're stateless, you must
write a rule for **both inbound and outbound** for any source or
target. The default NACL rules are
`All traffic, from/to 0.0.0.0/0` for both directions.

> I rarely use NACLs unless there's a specific need to block a
> set of IP addresses at the subnet level — quite rare in my
> experience, and should be used with caution.

### Allow access by IP and request URI path

Use the **AWS Web Application Firewall (WAF)**. Pseudo-rule:

```
if AND(
  URI-Path == https://myapp.com/admin/dashboard,
  SourceIP != Whitelisted-IPs
)
then Block
```

Steps:

- Create a rule for **web request component settings** with the
  required `URI Path`.
- Create an **IP set** named `whitelisted` containing your IP.
- Create another rule that whitelists those IPs.

## Selecting the right defense

1. **Security Groups** — designed to **Allow** traffic from/to
   sources, at the **VPC level**.
2. **NACLs** — block a set of IP addresses (bots, bad reputation,
   etc.) at the **Subnet level**.
3. **AWS WAF** — block all traffic to a specific `URI-Path`,
   allow only from a whitelisted set of IP addresses, at the
   application layer.

## Final words

Security Groups were one of the first AWS components I
encountered — and I had no networking background, so "stateless"
and "stateful" meant nothing. Once I broke down which service is
for which purpose, it all clicked.
