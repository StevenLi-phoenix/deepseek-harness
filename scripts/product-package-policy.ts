/** Non-default package roles retained outside the experimental group. */

/** Product role that does not require a default runtime mount. */
export type ProductPackageCategory = 'optional' | 'sdk' | 'build' | 'test' | 'web-distribution' | 'declarations'

/** One explicitly maintained package role and its reason. */
export interface ProductPackagePolicy {
  /** Why this package remains outside the experimental group. */
  readonly reason: string
  /** The supported product role checked against its directory. */
  readonly category: ProductPackageCategory
}

/**
 * Exceptions to default runtime reachability, keyed by repository-relative package directory.
 * Optional integrations may be reached by an optional bundle without becoming default capabilities.
 */
export const PRODUCT_PACKAGE_POLICY: Readonly<Record<string, ProductPackagePolicy>> = {
  'packages/core/agent-tool-presentation': { category: 'optional', reason: 'Deprecated selector retained for existing executor configurations.' },
  'packages/browser-use/browser-use': { category: 'optional', reason: 'Service definition used by explicitly selected browser providers.' },
  'packages/computer-use/computer-use': { category: 'optional', reason: 'Service definition used by explicitly selected computer providers.' },
  'packages/lsp/lsp': { category: 'optional', reason: 'Service definition for deployment-configured language servers.' },
  'packages/fork/provider-balance': { category: 'optional', reason: 'Fork-local composer balance pill mounted by the event profile bundle.' },
  'packages/fork/event-bus': { category: 'optional', reason: 'Fork-local event bus mounted by the deployment-owned event profile.' },
  'packages/fork/qq': { category: 'optional', reason: 'Fork-local QQ group observer; requires a OneBot v11 protocol end (NapCat) logged in to a QQ account.' },
  'packages/fork/qqbot': { category: 'optional', reason: 'Fork-local official QQ bot channel (disabled by default); requires a QQ Open Platform bot (AppID and AppSecret).' },
  'packages/fork/tool-qq': { category: 'optional', reason: 'Fork-local read-only QQ tools mounted by the event profile preset.' },
  'packages/fork/turn-taint': { category: 'optional', reason: 'Fork-local turn origin for the owner\'s main agent; mounted by the event profile preset.' },
  'packages/fork/integrity-watch': { category: 'optional', reason: 'Fork-local integrity watch for the owner\'s main agent; mounted by the event profile.' },
  'packages/fork/courses': { category: 'optional', reason: 'Fork-local course records client and deadline reminder poller; mounted by the event profile bundle.' },
  'packages/fork/courses-settings': { category: 'optional', reason: 'Fork-local Settings section for course deadline reminders mounted by the event profile bundle.' },
  'packages/fork/subagent-activity': { category: 'optional', reason: 'Fork-local right-Sidebar subagent page and its activity projection mounted by the event profile bundle.' },
  'packages/fork/tool-courses': { category: 'optional', reason: 'Fork-local course record tools mounted by the event profile preset.' },
  'packages/fork/gmail': { category: 'optional', reason: 'Fork-local Gmail client for the owner\'s accounts with a send gate; mounted by the event profile bundle; needs a Google OAuth client.' },
  'packages/fork/gmail-settings': { category: 'optional', reason: 'Fork-local Settings section and OAuth return page for the Gmail accounts, mounted by the event profile bundle.' },
  'packages/fork/tool-gmail': { category: 'optional', reason: 'Fork-local Gmail tools mounted by the event profile preset.' },
  'packages/fork/time-gap': { category: 'optional', reason: 'Fork-local time check before an input that ends a quiet spell in a Session; mounted by the event profile bundle.' },
  'packages/fork/wechat': { category: 'optional', reason: 'Fork-local WeChat channel; requires a QR-bound iLink bot account.' },
  'packages/fork/tool-wechat': { category: 'optional', reason: 'Fork-local WeChat file tool mounted by the event profile preset.' },
  'packages/fork/voice': { category: 'optional', reason: 'Fork-local voice service (speech and transcription through the owner\'s own services) mounted by the event profile bundle.' },
  'packages/fork/tool-up': { category: 'optional', reason: 'Fork-local up_* tools for the creator account (bili-svc) mounted by the event profile\'s up preset.' },
  'packages/fork/tool-voice': { category: 'optional', reason: 'Fork-local speak tool mounted by the event profile preset.' },
  'packages/fork/tool-watch': { category: 'optional', reason: 'Fork-local watch tools mounted by the event profile preset.' },
  'packages/fork/github-sensor': { category: 'optional', reason: 'Fork-local sensor; requires configured repositories and tokens.' },
  'packages/fork/event-ingest': { category: 'optional', reason: 'Fork-local push route for the owner\'s services; requires per-source tokens.' },
  'packages/fork/tool-monitor': { category: 'optional', reason: 'Fork-local monitor tools mounted by the event profile preset.' },
  'packages/fork/cc-bridge': { category: 'optional', reason: 'Fork-local tools for the service user\'s own Claude Code sessions, mounted by the event profile preset; needs Claude Code provisioned for the service user.' },
  'packages/fork/owner-relay': { category: 'optional', reason: 'Fork-local relay of Session answers to the owner\'s channels, mounted by the event profile bundle.' },
  'packages/fork/owner-memory': { category: 'optional', reason: 'Fork-local owner memory (context block and memory tools) mounted by the event profile preset.' },
  'packages/fork/owner-memory-admin': { category: 'optional', reason: 'Fork-local Memory settings section (browser half) for the owner\'s review of agent memory, mounted by the event profile bundle; its Host route is owner-memory\'s settings entry.' },
  'packages/fork/wechat-settings': { category: 'optional', reason: 'Fork-local WeChat and quiet-hours settings sections (browser half) mounted by the event profile bundle; their Host routes are served by wechat and presence.' },
  'packages/fork/presence': { category: 'optional', reason: 'Fork-local owner presence (Sleep Focus, daily window, quiet-hours Settings section) mounted by the event profile bundle.' },
  'packages/fork/content-guard': { category: 'optional', reason: 'Fork-local content validator (patterns, canaries, memory overlap, model) for text others can read, mounted by the event profile bundle; reads the owner memory file and the profile default model.' },
  'packages/fork/sysmon': { category: 'optional', reason: 'Fork-local System status settings section mounted by the event profile bundle.' },
  'packages/fork/speaking-style': { category: 'optional', reason: 'Fork-local speaking-style samples (QQ groups and Bilibili comments) shown to the main agent, mounted by the event profile bundle; reads the QQ observer and bili-svc.' },
  'packages/fork/speaking-style-settings': { category: 'optional', reason: 'Fork-local speaking-style settings section mounted by the event profile bundle; needs speaking-style.' },
  'packages/fork/plugin-config': { category: 'optional', reason: 'Fork-local All settings card for Settings sections, mounted by the event profile bundle.' },
  'packages/fork/qq-login': { category: 'optional', reason: 'Fork-local QQ settings section (observer connection, NapCat login, login QR code) mounted by the event profile bundle; needs the QQ observer.' },
  'packages/fork/cc-admin': { category: 'optional', reason: 'Fork-local Claude Code session service for the settings console, mounted by the event profile bundle.' },
  'packages/fork/event-console': { category: 'optional', reason: 'Fork-local settings sections (service overview, subscriptions and reminders, Claude Code and voice) mounted by the event profile bundle.' },
  'packages/fork/bili': { category: 'optional', reason: 'Fork-local Bilibili account client of bili-svc and its settings section; requires bili-svc and its BILI_SVC_TOKEN_BILI token.' },
  'packages/fork/tool-bili': { category: 'optional', reason: 'Fork-local Bilibili tools mounted by the event profile bili preset.' },
  'packages/lsp/lsp-stdio': { category: 'optional', reason: 'Requires an explicit server list and language-server executables.' },
  'packages/lsp/tool-lsp': { category: 'optional', reason: 'Model tools selected together with a configured LSP provider.' },
  'packages/ssh/ssh': { category: 'optional', reason: 'Explicit remote connection and helper configuration.' },
  'packages/ssh/ssh-helper-runtime': { category: 'optional', reason: 'Private executable carrier for explicitly configured SSH connections.' },
  'packages/ssh/fs-ssh': { category: 'optional', reason: 'Remote filesystem provider selected in an SSH composition.' },
  'packages/ssh/sandbox-ssh': { category: 'optional', reason: 'Remote confinement provider selected in an SSH composition.' },
  'packages/ssh/subprocess-ssh': { category: 'optional', reason: 'Remote process provider selected in an SSH composition.' },
  'packages/storage/storage-sqlite': { category: 'optional', reason: 'Persistent storage requires an explicit database path and backend selection.' },
  'packages/subagent/subagent-acp': { category: 'optional', reason: 'Requires a configured external ACP agent command.' },
  'packages/subagent/subagent-claude-code': { category: 'optional', reason: 'Separately installed native Claude Code agent integration.' },
  'packages/subagent/subagent-codex': { category: 'optional', reason: 'Separately installed native Codex agent integration.' },
  'packages/subagent/subagent-dsh-sdk': { category: 'optional', reason: 'Requires an explicitly configured external DSH home.' },
  'packages/context/tmux-context': { category: 'optional', reason: 'Context contribution requiring a tmux pane.' },
  'packages/fs/tool-str-replace-editor': { category: 'optional', reason: 'Explicit alternative to the default filesystem editing tools.' },
  'packages/fs/fs-observation-policy': { category: 'optional', reason: 'Read-before-mutation guard that a deployment enables on the disabled dsh-base row.' },
  'packages/sdk/client': { category: 'sdk', reason: 'Published TypeScript embedding client runs in the consumer process.' },
  'packages/typert/generator': { category: 'build', reason: 'Build-time generation of type metadata.' },
  'packages/test-support/agent-loop-testkit': { category: 'test', reason: 'Published agent-loop test harness.' },
  'packages/test-support/tool-testkit': { category: 'test', reason: 'Shared tool definition and execution fixtures for tests and benchmarks.' },
  'packages/test-support/client-runtime': { category: 'test', reason: 'Published browser plugin test harness.' },
  'packages/test-support/llm-mock-server': { category: 'test', reason: 'Published model-provider test server.' },
  'packages/test-support/llm-replay': { category: 'test', reason: 'Published recorded-model replay harness.' },
  'packages/test-support/loader-smoke': { category: 'test', reason: 'Published plugin Loader smoke-test harness.' },
  'packages/test-support/remote-mock': { category: 'test', reason: 'Published typed Remote test proxies.' },
  'packages/test-support/session-snapshot': { category: 'test', reason: 'Published Session snapshot replay harness.' },
  'packages/client/web': { category: 'web-distribution', reason: 'Browser boot kernel bundled into the Web distribution.' },
  'packages/client/ui-dockkit': { category: 'web-distribution', reason: 'Layout library bundled into the Web distribution.' },
  'packages/util/package-manifest': { category: 'declarations', reason: 'Shared package metadata declarations have no runtime mount.' },
}
