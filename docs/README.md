# docs assets

Static assets referenced by the top-level docs.

- `architecture-dark.webp` — the detailed architecture visual. It is retained
  for reference but is not embedded in the top-level README.

README visuals use WebP to keep pages lightweight. To export a revised source
PNG:

```sh
cwebp -q 90 source.png -o architecture-dark.webp
```
