---
title: "AWS S3 Files in Context: Choosing the Right Shared Filesystem on AWS"
url: "https://meirg.co.il/2026/05/12/amazon-s3-files-vs-efs-when-to-use-which/"
published: "2026-05-12"
tags: ["aws", "s3", "efs", "ai", "agents", "storage", "nfs", "cloud"]
read_minutes: 7
author: "Meir Gabay"
source: "meirg.co.il"
---

# AWS S3 Files in Context: Choosing the Right Shared Filesystem on AWS

AWS just announced **Amazon S3 Files**, and my first reaction was
simple: where does this fit among the shared filesystem options
on AWS?

That's the right question.

At first glance, S3 Files sounds similar to tools people already
know:

- **Mountpoint for S3**
- **goofys**
- **s3fs-fuse**
- and sometimes **Amazon EFS**

But they aren't solving the exact same problem.

If you're building modern workloads on AWS — apps, data pipelines,
agent workflows, ML jobs, file-heavy automation — this is the
split I'd use:

- **Use Amazon S3 Files** when your source of truth should remain
  in S3, but your agent or pipeline wants normal file operations.
- **Use Mountpoint for S3** when you mostly need high-throughput
  reads of large S3 objects.
- **Use goofys or s3fs-fuse** when you specifically want a
  client-side FUSE mount and accept the tradeoffs.
- **Use Amazon EFS** when you need a real shared file system
  first, not just S3 with a file-like interface.

## What AWS actually announced

According to the AWS announcement and the S3 Files docs,
**Amazon S3 Files makes an S3 bucket accessible as a shared file
system** with file-system semantics, low-latency access for active
data, and synchronization between file operations and S3 objects.

The important part: your data still lives in S3, and the AWS
synchronization docs are explicit that the **linked S3 bucket
remains the long-term store and the source of truth in conflict
scenarios**.

That's what makes it different from EFS, and also different from
most older "mount S3 like a file system" tools.

## Why this matters for modern AWS workloads

A lot of modern systems still work through files, even when the
backend is object storage.

Think about what agents and ML workflows actually do:

- read prompt templates
- load datasets
- write logs and checkpoints
- share artifacts between steps
- generate images, reports, intermediate outputs
- call Python libraries and CLI tools that expect paths, not S3
  object APIs

That's why S3 Files is interesting.

Before this, teams usually had to do one of:

1. rewrite tooling around the S3 API
2. stage data into EFS before processing
3. use a client-side mount like goofys or s3fs-fuse
4. build custom sync glue between S3 and another file system

S3 Files is AWS trying to remove that mess.

## The cleanest mental model

### Amazon S3 Files

A **managed shared file system over S3**. AWS owns the file-system
layer. You get mount targets, access points, NFS semantics, plus
documented synchronization behavior.

### Mountpoint for S3

A **high-throughput S3 file client**. AWS says it's ideal for
large-scale read-heavy applications, creating new files, and
working with large S3 datasets through file operations.

### goofys

A **POSIX-ish FUSE mount for S3**. The project literally describes
itself as "performance first and POSIX second."

### s3fs-fuse

A **more filesystem-like FUSE mount for S3**. It supports a larger
subset of POSIX, but still inherits the awkward reality that S3
isn't a real local filesystem.

### Amazon EFS

A **real shared file system**. With EFS, the file system **is**
the product. With S3 Files, S3 stays the source of truth.

## The biggest difference: who owns the filesystem semantics?

With **S3 Files**, AWS owns the shared file-system abstraction
over S3.

With **Mountpoint, goofys, and s3fs-fuse**, the **client** is
translating file operations into S3 API calls. That makes them
much closer to mount or access approaches than to a standalone
shared filesystem product.

That changes things like multi-client behavior, rename semantics,
write behavior, locking, consistency expectations, operational
support, and blast radius.

This is why S3 Files feels more like a platform capability while
the FUSE tools feel more like adapters.

## Mountpoint for S3 vs S3 Files

If I had to pick the most relevant comparison for most AWS
builders, it would be S3 Files vs Mountpoint for S3.

Mountpoint is optimized for:

- reading large objects from S3
- high read throughput
- many clients reading at once
- sequential creation of new objects

What it's **not** for on general purpose buckets:

- editing existing files
- directory renames
- symlinks
- file locking
- full POSIX behavior

That makes Mountpoint very compelling for model training input
data, ETL and batch reads, media pipelines reading large assets,
and read-heavy retrieval corpora. But if your workload needs a
**shared writable file system abstraction over S3**, S3 Files is
the more interesting option.

## goofys: fast, lightweight, honest about tradeoffs

I appreciate how honest goofys is. It calls itself a "filey
system" instead of a filesystem.

Its README says:

- performance first
- POSIX second
- no on-disk data cache by default
- sequential writes only
- no stored file mode/owner/group
- no symlink or hardlink
- `fsync` ignored
- close-to-open consistency

Make sense for an agent or tool to read from S3 with minimal fuss.
Not a managed shared storage layer.

## s3fs-fuse: more POSIX-ish, still not a real shared FS

s3fs-fuse supports more filesystem-like behavior than goofys —
random writes and appends, symlinks, mode and uid/gid, local disk
cache, multipart upload — but its docs call out: no atomic
renames, no hard links, no coordination between multiple clients
mounting the same bucket, slow metadata operations.

Still a client-side translation layer over object storage.

## Where S3 Files feels strongest

### 1. Agent runtimes

This became real with the **AgentCore release notes**. AgentCore
Runtime now supports attaching both Amazon S3 Files **and**
Amazon EFS directly to agent runtimes.

Design decision:

- **S3 Files** for shared datasets, prompt libraries, generated
  artifacts, S3-resident knowledge.
- **EFS** for shared mutable working state, tool caches,
  traditional filesystem behavior.

### 2. ML pipelines that already live on S3

Instead of:

- download to local or EFS
- process
- upload back to S3

you get:

- work on the S3-backed filesystem directly

### 3. Multi-step agent pipelines

If one step writes artifacts and another reads them, with the
long-term home in S3, S3 Files is attractive.

## Where EFS is still the better choice

Even with the AI angle, EFS is still better when the file system
itself is the product:

- shared mutable workspaces
- package caches
- classic NFS-style app storage
- home directories
- tool directories shared across workers
- multi-agent systems behaving like a real shared Linux FS

If your first sentence is "I need a real shared file system,"
EFS is still probably the safer answer.

If your first sentence is "My data belongs in S3, but my tools
want paths and files," S3 Files becomes much more interesting.

## What about WordPress?

For WordPress, I'd still choose **EFS** for the runtime. Why?

- WordPress is a shared mutable filesystem workload
- plugins, themes, and uploads fit traditional filesystem behavior
- much closer to classic shared app storage than AI pipeline
  storage

WordPress is a good sanity check — it shows where S3 Files is
**not** the main answer, even though it sounds shiny.

## My rule of thumb

> Use **S3 Files** when S3 is the truth and files are the
> interface. Use **EFS** when the file system itself is the
> truth. Use **Mountpoint** when you mostly want fast reads from
> S3.

That's the split I'd use in practice.

## Final take

S3 Files doesn't kill EFS. It doesn't kill Mountpoint, goofys,
or s3fs-fuse either.

What it kills is a very specific kind of ugly glue: copy S3 data
into another filesystem, run file-based tools on it, sync it
back, hope your semantics still make sense.

The better question now isn't "Can I mount S3 like files?" — we
already had several answers to that. The better question is:
**"Do I want a client-side mount, a managed shared file system
over S3, or a real standalone shared file system?"**
