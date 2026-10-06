# Releasing

Pi's gallery discovers npm packages with the `pi-package` keyword. This package includes that keyword and a `pi.extensions` manifest. See [Pi package documentation](https://pi.dev/docs/latest/packages).

## Prepare

1. Review the package name/version and license. Add real repository, homepage, bugs and author metadata if a public repository/identity has been chosen; no placeholder identity is included.
2. Run `npm ci`, `npm run check`, `npm run triage:setup`, and `npm run test:laya`.
3. Test another Pi installation with `PI_TRIAGE_TEST_PI_DIR=/absolute/path/to/pi-coding-agent npm run test:integration`. The directory must contain `dist/cli.js`.
4. Run `npm pack --dry-run`, then `npm pack`. Inspect the allowlisted tarball. It must contain the TypeScript entrypoint, core modules, Python worker/installer, lock file, docs and notices; it must exclude model weights, runtime caches, sessions, credentials, node_modules and tests.
5. Update the changelog and validation notes with actual results. The CI matrix covers Pi 0.85.1 and 1.0.4 on Node 22.19 and 24; real model validation is a separate job.

## Publish

When ready to publish from the intended npm account:

```sh
npm publish ./pi-knowledge-triage-compactor-0.1.0.tgz --access public
```

Publication requires npm account access and package-name availability. Preparing or packing this directory does not publish it or reserve its name. Gallery indexing is controlled by pi.dev and may not be immediate.

After publication, check installation in a disposable Pi agent directory using `pi install npm:pi-knowledge-triage-compactor@0.1.0` and confirm `/triage status` and retrieval registration.
