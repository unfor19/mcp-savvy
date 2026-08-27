---
title: "Beyond the Hype: Rediscovering Why Containers Won"
url: "https://meirg.co.il/2025/07/16/beyond-the-hype-rediscovering-why-containers-won/"
published: "2025-07-16"
tags: ["containers", "virtualization", "docker", "devops"]
read_minutes: 5
author: "Meir Gabay"
source: "meirg.co.il"
---

# Beyond the Hype: Rediscovering Why Containers Won

Ever feel like you missed the memo on why everyone's obsessed with
containers? I was having that exact conversation with a colleague
last week. They asked me, "Why don't we just run each app on its
own tiny VM?" Fair question. Containers didn't win by accident —
they solved real problems that were driving us all crazy.

## The real difference: containers vs VMs

Containers and VMs both do isolation, but they solve it in
completely different ways:

| Concern               | Containers                            | VMs                       |
| --------------------- | ------------------------------------- | ------------------------- |
| How they isolate      | Share the kernel, separate processes  | Each gets its own full OS |
| Startup time          | Seconds (sometimes ms)                | Minutes                   |
| Memory footprint      | Megabytes                             | Gigabytes                 |
| Density per server    | Tons                                  | Limited by OS overhead    |
| "Works on my machine" | Mostly solved                         | Still a problem sometimes |
| Security              | Good, but shared kernel = shared risk | Stronger isolation        |

## Why containers feel like magic (they're not)

Booting a VM means starting a whole computer inside your computer.
The hypervisor pretends to be hardware, the guest OS goes through
its full boot, services initialize — it's a lot.

Containers are just processes. Really well-isolated processes,
but still processes. They use your existing kernel and sandbox
everything else. So:

- **Instant startup** (milliseconds to seconds)
- **Less memory waste** (no duplicate OS copies)
- **More density** on the same hardware
- **Smaller cloud bills** (this adds up)

## The security reality check

Containers aren't a magical security fortress. They share the
host kernel — if someone finds a kernel exploit, they could
potentially break out of all containers on that host.

VMs each have their own OS through a hypervisor. That's like
separate apartments vs. separate rooms with really good locks.

A lot of smart teams run **containers inside VMs**. Speed and
efficiency of containers, with an extra layer of VM isolation.

## The "works on my machine" problem

Containers package everything together — your app, dependencies,
runtime, even specific library versions. When you ship a container,
you're shipping the exact environment your code was tested in.

This revolutionized building and deploying:

- No environment drift between dev, staging, production
- CI/CD pipelines that work consistently
- Easy rollbacks (swap container images)
- Language mixing (Python next to Go? Fine.)

## Why CFOs love containers

When you can run 10x more applications on the same hardware,
fewer servers to buy, maintain, and power. Cloud bills shrink
because you're not paying for idle operating systems doing
nothing.

One IBM study claimed containers can cut server maintenance,
administration, and facilities costs by **about 75%** compared
to VMs. Take that with salt — these studies always sound too
good — but the basic math holds.

## Kubernetes: containers with superpowers

Containers alone are cool, but with orchestration:

- **Auto-scaling** (traffic spike → more containers appear)
- **Self-healing** (container crashes → new one starts)
- **Zero-downtime deployments** (rolling updates)
- **Service discovery** (no hardcoded IPs)

Adoption is wild — apparently **96% of organizations** are using
Kubernetes now.

## When you should still use VMs

Containers aren't the answer to everything. VMs still make more
sense for:

- **Legacy apps** built assuming they own a whole machine
- **Compliance** that demands hardware-level isolation
- **Mixed-OS environments** (Windows + Linux on the same host)
- **Untrusted workloads** (running customer code)

Most companies run hybrid: containers for new cloud-native stuff,
VMs for legacy and security-sensitive workloads, often containers
inside VMs for the extra isolation layer.

## What's next: the lines blur

New tech like **AWS Firecracker** and serverless containers
(Fargate, Cloud Run) give VM-level security with container-level
performance. **Micro-VMs** start almost as fast as containers but
with better isolation. Best of both worlds without picking sides.

## Why containers won

Not marketing. They solved real problems:

- The "works on my machine" problem
- Slow deployment cycles
- Expensive, wasteful infrastructure
- Environment inconsistencies
- Scaling headaches

The smartest teams use containers where they shine, VMs where
they must, and aren't religious about either.
