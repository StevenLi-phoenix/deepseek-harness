/**
 * Memory settings page, node half. The empty apply exists so the plugin appears in the Loader and the
 * browser half (exports["./client"], discovered from the package.json dsh.client declaration) is delivered.
 * The Host route the page talks to, `/api/lsy.memory`, is `@deepseek-ai/dsh-lsy-memory/settings`: it needs
 * the memory store, which a package with a browser face may not import at runtime.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
