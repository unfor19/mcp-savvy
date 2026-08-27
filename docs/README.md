# docs assets

Static assets referenced by the top-level docs.

- `architecture-dark.webp` — the architecture diagram embedded in
  [README.md](../README.md#architecture). Dark-mode, exported as
  WebP at native resolution (quality 90) to keep the README
  lightweight while keeping the labels crisp. Keep the filename
  stable so the README link stays valid.

To regenerate from a new source PNG:

```sh
cwebp -q 90 source.png -o architecture-dark.webp
```
