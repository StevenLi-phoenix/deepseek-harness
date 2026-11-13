/**
 * WeChat and quiet-hours settings pages, node half. The empty apply exists so the plugin appears in the Loader
 * and the browser half (exports["./client"], discovered from the package.json dsh.client declaration) is
 * delivered. The Host routes the pages talk to, `/api/wechat` and `/api/presence`, are served by
 * `@deepseek-ai/dsh-wechat` and `@deepseek-ai/dsh-presence`: they need the live channel and the presence
 * service, which a package with a browser face may not import at runtime.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
