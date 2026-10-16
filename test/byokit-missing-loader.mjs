// Test-only `--import` hook: every BYOKit (and its pi-ai model list) import fails
// exactly as with BYOKit not installed, so the pick's never-fails fallback runs.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@byokit/') || specifier.startsWith('@earendil-works/')) {
      throw Object.assign(new Error(`Cannot find package '${specifier}'`), { code: 'ERR_MODULE_NOT_FOUND' });
    }
    return next(specifier, context);
  },
});
