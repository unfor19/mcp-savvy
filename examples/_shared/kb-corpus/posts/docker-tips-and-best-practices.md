---
title: "Docker Tips And Best Practices"
url: "https://meirg.co.il/2021/02/11/docker-tips-and-best-practices/"
published: "2021-02-11"
tags: ["docker", "tips", "tutorial", "bestpractice"]
read_minutes: 9
author: "Meir Gabay"
source: "meirg.co.il"
---

# Docker Tips And Best Practices

Five tips, tricks, and best practices for using Docker.

## Analogy

The Dockerfile is a recipe for creating Docker images. Treat it
like the recipe for your favorite cake — concise, readable, easy
to follow. Multi-stage builds are like splitting baking into
stages: the final product (Docker image) ships only what's
needed. We don't want to ship the cake with a bag of sugar
(source code) or with the oven (build packages). Reusable
keywords (`ARG`) act as references — declared once, used
everywhere.

## Topics

1. Order Of Commands
2. Multi-Stage Build
3. Run As A Non-Root User
4. Mind The UID GID
5. Global ARGs

## Order Of Commands

A Docker command (ARG, ENV, RUN, etc.) that doesn't need to
re-execute when source code changes should be pushed to the top
of the file. The base of the image is at the **top** of the
Dockerfile.

Bad — copies code first, then installs requirements:

```dockerfile
COPY . /code/
RUN pip install --user -r "requirements.txt"
```

Every source-code change purges the requirements cache. Bad.

Good — copy lock file first, install, *then* copy code:

```dockerfile
COPY requirements.txt /code/
RUN pip install --user -r "requirements.txt"
COPY . /code/
```

Now the requirements layer is cached unless `requirements.txt`
itself changes.

> Docker caches commands that haven't affected the file system
> during the build. The order of `RUN`, `WORKDIR`, and `COPY` is
> crucial.

## Multi-Stage Build

Multi-stage builds let you release slim images that include only
runtime dependencies. The pattern:

```dockerfile
ARG PYTHON_VERSION="3.9.1"

FROM python:${PYTHON_VERSION}-slim as build
RUN pip install --upgrade pip && \
    pip install --upgrade wheel setuptools check-wheel-contents
COPY requirements.txt /code/
RUN pip install --user -r "requirements.txt"
COPY . /code/
# ... build steps that produce /dist ...

FROM python:${PYTHON_VERSION}-slim as app
WORKDIR /myapp/
COPY --from=build /dist/ /myapp/
ENTRYPOINT ["app"]
```

The last `FROM` in the Dockerfile is the final image. Naming the
final stage `app` (or `prod`) makes intent clear and only
relevant content is shipped.

## Run As A Non-Root User

The default user is `root` — fine for build steps that run behind
the scenes, but **not fine** for the runtime container.

Picture this: John, the nifty hacker, hacks into your application
running as root. He can `apt-get install ANYTHING`, install
`mysql`, talk to your database. Why give him that?

Solution — switch users with `USER`:

```dockerfile
FROM python:3.9.1-slim as app
WORKDIR /myapp/
RUN addgroup appgroup --gid 1000 && \
    useradd appuser --uid 1000 --gid appgroup --home-dir /myapp/ && \
    chown -R appuser:appgroup /myapp/
USER appuser
COPY --from=build --chown=appuser:appgroup /myapp/
ENTRYPOINT ["app"]
```

Now John can't `apt-get install`. He gets `permission denied`
writing to `/root/`. He still might do harm if he's very
talented, but you've minimized the collateral damage.

## Mind The UID GID

`--uid 1000` and `--gid 1000` are the default values for a new
user/group on Ubuntu. If you're on WSL2 Ubuntu 20.04 your local
user is also `1000:1000`, so the IDs line up.

If your container runs as `root` and writes a file mounted from
the host, the file ends up owned by `root` on your host:

```
$ ls -lh root-file.txt
-rw-r--r-- 1 root root 14 Feb 12 14:04 root-file.txt
$ echo "more contents" >> root-file.txt
bash: root-file.txt: Permission denied
```

You'd need `sudo` to edit it from your IDE. Bad UX. With matching
UID/GID (`1000:1000` inside the container, `1000:1000` on the
host), files come out owned by your local user.

## Global ARGs

Declare reusable values once at the top of the Dockerfile:

```dockerfile
ARG PYTHON_VERSION="3.9.1"

FROM python:${PYTHON_VERSION}-slim as build
# ...
FROM python:${PYTHON_VERSION}-slim as app
ENTRYPOINT ["app"]
```

DRY beats hardcoding the same version twice.

## Final words

A full example of a containerized Python CLI is at
`unfor19/frigga` — built with all of these practices, plus a
GitHub Actions test suite that exercises both docker-compose and
Kubernetes paths.
