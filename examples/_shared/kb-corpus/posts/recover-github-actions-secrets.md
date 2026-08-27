---
title: "How To Recover Secrets From GitHub Actions"
url: "https://meirg.co.il/2022/07/01/how-to-recover-secrets-from-github-actions/"
published: "2022-07-01"
tags: ["devops", "cicd", "githubactions", "secrets"]
read_minutes: 3
author: "Meir Gabay"
source: "meirg.co.il"
---

# How To Recover Secrets From GitHub Actions

Secrets are hidden from CI/CD logs with `***`. Example:

```yaml
jobs:
  openssl:
    runs-on: ubuntu-20.04
    steps:
      - env:
          MY_CLIENT_SECRET: ${{ secrets.MY_CLIENT_SECRET }}
        run: |
          echo "MY_CLIENT_SECRET (***) = ${MY_CLIENT_SECRET}"
```

Output:

```
MY_CLIENT_SECRET (***) = ***
```

Not very helpful when you actually need to recover the value.

## Quick and dirty (dangerous): `base64`

For **private** repositories only, you can encode the secret with
base64 before printing it. GitHub Actions won't auto-mask the
encoded form. Copy the encoded value, decode it locally:

```yaml
jobs:
  base64:
    runs-on: ubuntu-20.04
    steps:
      - uses: actions/checkout@v3
      - env:
          MY_CLIENT_ID: ${{ secrets.MY_CLIENT_ID }}
        run: |
          echo "MY_CLIENT_ID (***) = ${MY_CLIENT_ID}"
          echo "MY_CLIENT_ID (base64) = $(echo ${MY_CLIENT_ID} | base64)"
          echo "Copy the above value, then execute locally:"
          echo "echo PASTE_HERE | base64 -D"
```

If the encoded value is `c29tZS1jbGllbnQtaWQtdmFsdWUK`:

```
echo c29tZS1jbGllbnQtaWQtdmFsdWUK | base64 -D
# some-client-id-value
```

This is **never safe for public repositories** — anyone who
sees the logs can decode it.

## The right way: encrypt with OpenSSL

Encrypt the secret in CI before printing it. Decrypting requires
the right `iter` count and `password`, both stored as separate
GitHub secrets.

```yaml
jobs:
  openssl:
    runs-on: ubuntu-20.04
    steps:
      - uses: actions/checkout@v3
      - env:
          MY_CLIENT_SECRET: ${{ secrets.MY_CLIENT_SECRET }}
          MY_OPENSSL_PASSWORD: ${{ secrets.MY_OPENSSL_PASSWORD }}
          MY_OPENSSL_ITER: ${{ secrets.MY_OPENSSL_ITER }}
        run: |
          echo "MY_CLIENT_SECRET (openssl) = $(echo "${MY_CLIENT_SECRET}" | \
            openssl enc -e -aes-256-cbc -a -pbkdf2 \
            -iter ${MY_OPENSSL_ITER} \
            -k "${MY_OPENSSL_PASSWORD}")"
```

The encrypted value (e.g. `U2FsdGVkX1+6/+7bvNG/Ga7siAI994FkMUn5Njzn4zyNwvf8qM3MY0MMmd9sCFvz`)
is safe in logs. To decrypt locally:

```
echo U2FsdGVkX1+...== | openssl base64 -d | \
  openssl enc -d -pbkdf2 -iter $MY_OPENSSL_ITER \
  -aes-256-cbc -k $MY_OPENSSL_PASSWORD
```

Without the right `iter` and password, you'd need a brute-force
attack — good luck with that.

The `-pbkdf2` flag enables **PBKDF2 key derivation**. High
`iter` values increase the time required to brute-force the
resulting ciphertext.

## Final words

Best practice — keep this in a separate workflow:
`.github/workflows/recover-github-secrets.yml`. Run it, recover
the secret, **delete the workflow logs immediately afterward**.
Don't leave even encrypted secrets sitting in CI logs longer
than you need.
