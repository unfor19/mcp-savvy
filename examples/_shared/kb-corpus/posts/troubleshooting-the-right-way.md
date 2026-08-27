---
title: "Troubleshooting the right way"
url: "https://meirg.co.il/2021/01/25/troubleshooting-the-right-way/"
published: "2021-01-25"
tags: ["troubleshooting", "bestpractice", "tips", "tutorial"]
read_minutes: 7
author: "Meir Gabay"
source: "meirg.co.il"
---

# Troubleshooting the right way

A methodology for troubleshooting technical challenges. As a
DevOps engineer, I face technical challenges daily. In my early
days I rushed into finding solutions because "everything is
time-critical." Rushing without a plan slowed me down and raised
my frustration on every new challenge.

## Change your mindset; it's a challenge

The fine-tuning from "issue" to "challenge" makes a big
difference. Tag tasks as challenges, puzzles, or mysteries — even
the boring ones — and solving them turns into a journey of
learning new things.

## The cheatsheet

Steps I go through when facing a new challenge. After enough
practice, most of them happen in your head.

1. **Define the challenge in simple words.**
   - Example: *"Disallow outbound connection from my server to a
     public remote storage service on the internet."*
2. **Decide how you'll test that it works**, *before* you write
   the solution. Defining the test up front mitigates the risk of
   biasing yourself toward a specific solution.
   - Example: *"I should stop seeing new data in the remote
     storage service."*
3. **Map the components.** Write or sketch the components and the
   flow. For very complicated challenges a draw.io diagram is
   worth the time, but most of the time a list is enough.
4. **Prioritize candidate solutions** along three axes:
   - **Reliability** — a permanent solution needs a good design.
     Ad-hoc fixes "just to make it work" are harder to
     troubleshoot for your colleagues or future you.
   - **Time to first results** — start with what fails fastest;
     don't begin with the longest-running solution, you'll be
     exhausted before you reach the others.
   - **Effort to explain** — if it takes 5 hours to explain the
     solution, it should be prioritized very low or dropped.
5. **Iterate over the solutions.** Start with the ones that
   produce results quickly. When you hit a working solution,
   write down the reproduction steps.
6. **Documentation.** For easy-to-moderate challenges, comments
   in the ticketing system (JIRA, Trello) are enough. Complex
   challenges deserve a real write-up.

## Real-life: blocking outbound from Prometheus to NewRelic

A customer running Prometheus on K3S on a single AWS EC2
instance (Ubuntu 18.04). Prometheus's `remote_write` ships
metrics to NewRelic. Initially I assumed seeing
`Done Replaying WAL` in Prometheus's logs meant `remote_write`
was successful. I was wrong.

**The challenge**: disallow outbound from Prometheus to NewRelic
to investigate which errors get raised when there's no internet.

**Test**: check NewRelic dashboards. New data should stop
arriving.

### Mapping the components

1. **Cloud-provider firewall** (AWS Security Group) — remove the
   `Allow outbound to 0.0.0.0/0` rule. *Difficulty: simple.*
2. **Server's firewall** (`ufw` on the EC2 instance) — add a
   `deny all outbound to 0.0.0.0/0` rule. *Difficulty: okay-ish.*
3. **Application** — Kubernetes Network Policy blocking
   `0.0.0.0/0`. *Difficulty: overkill.*
4. **Subnet's NACLs** — add `outbound deny 0.0.0.0/0`. **Dropped
   — would affect other resources in the same subnet.**
5. **Subnet's Routes Table** — remove the route to `0.0.0.0/0`.
   **Dropped for the same reason.**

> **Note**: all this could've been avoided with a deeper
> understanding of *stateful*. From AWS docs about Security Group
> connection tracking: a change to an inbound/outbound rule that
> initially allows a connection **will not break existing
> connections.**

### Iterating

**Security Group rule**: removed `0.0.0.0/0` outbound. New data
**still came**. I was shocked — I was counting on this.

**Server's firewall (ufw)**: ran `sudo ufw default deny outgoing`.
New data **still came**.

I used `nc` to verify the EC2 had no internet:

```
nc -v -w 3 metric-api.newrelic.com 443
# nc: connect to metric-api.newrelic.com port 443 (tcp) timed out
```

So no internet, but data was still flowing. To rule out a NewRelic
issue, I shut down the EC2 entirely — and **NewRelic stopped
receiving new data**. Confirmed: client-side problem.

### The epiphany

Shutting down the EC2 worked. Changing rules didn't. Why?

I scaled Prometheus down to 0, changed the Security Group rule,
scaled Prometheus back up to 1:

```
kubectl scale --replicas=0 deployment/prometheus
# Modify Security Group: remove outbound 0.0.0.0/0
kubectl scale --replicas=1 deployment/prometheus
# NewRelic > Check for new data > No new data!
```

It worked. Stopping Prometheus broke the **active connection** it
had with NewRelic. `remote_write` keeps an active connection — I
was sure it just sent and closed. Documented in Prometheus
1.8.0 / 2017-10-06: *"Remote storage connections use HTTP
keep-alive."*

## Final words

The effort of applying a solution is negligible compared to the
effort of finding the root cause. That's why getting results
quickly improves the ability to understand what's going on under
the hood. Failing solutions are like worked examples: an output
generated by a known sequence of steps.

> "Facing challenges is an adventure, so enjoy the ride and make
> sure you take notes; rock on!" 🤘
