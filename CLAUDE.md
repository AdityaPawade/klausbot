## Pre-commit checklist

Before every `git commit` and `git push`, run:

```sh
npm run format
npm run check
```

`format` fixes formatting in-place. `check` runs typecheck + format verification + lint (read-only, CI-safe). Both must pass clean before committing.
