/**
 * The event service's data flow as a graph: where an event comes from, what it passes through, and where an answer goes.
 * The boxes are written down here, drawn in the flow editor and exported from it (`nodes` and `edges` of its JSON), so a box may
 * name something not wired yet; `flow-live.ts` replaces the arrows of every box that is a route with what the route really does.
 * A hexagonal `cond` box asks a question and its
 * arrows carry the answer. Each box has a fixed cell, one row per kind of source, so the picture stays in the owner's mental map
 * when it grows, and
 * `flow-graph.client.spec.ts` fails on a cycle, a dangling arrow, or a question without both answers. Pure data.
 */

import { buildGraph, type FlowEdge, type FlowNode } from './flow-model.ts'

/**
 * Every box, in the order that breaks ties inside a column. `wired`, `via` and `gap` say how far the running service matches the
 * drawing: a box with none is live, one marked `partial` is wired differently or in part, and `planned` is not built. `via` names
 * what carries it as plain identifiers; `gap` says in the owner's words how the service differs.
 */
export const NODES: readonly FlowNode[] = [
  { id: 'wechatIn', cell: [0, 0], role: 'source', service: 'wechat', manage: 'fork-wechat', via: 'fork-wechat' },
  { id: 'qq', cell: [0, 7], tracks: { sources: ['qq'] }, role: 'source', service: 'qq', manage: 'fork-qq', via: 'fork-qq · qq-recorder' },
  { id: 'bili', cell: [0, 9], tracks: { sources: ['bili'] }, role: 'source', service: 'bili', manage: 'bili', via: 'bili-svc · ingest source bili' },
  { id: 'github', cell: [0, 3], tracks: { sources: ['github'] }, role: 'source', via: 'fork-github-sensor · webhook-github' },
  {
    id: 'pipelines', cell: [0, 11], tracks: { sources: ['kaorou'], subscriptions: ['kaorou'] }, role: 'source', wired: 'partial', via: 'ingest source kaorou · subscription kaorou',
    gap: '图上连向 AMS 分组；实际由 kaorou 订阅每批起一个 Session，不经 AMS。',
  },
  { id: 'host', cell: [0, 4], tracks: { sources: ['host'] }, role: 'source', via: 'ingest source host · subscriptions host-alerts, notify-funnel' },
  { id: 'ams', cell: [0, 5], role: 'source', service: 'ams', via: 'AMS escalation journal' },
  {
    id: 'operator', cell: [0, 2], tracks: { sources: ['operator'], subscriptions: ['operator'] }, role: 'source', wired: 'partial', via: 'ingest source operator · subscription operator',
    gap: '实际是独立的 Session，答案经 owner-relay 发到微信，不进主聊天 Session。',
  },
  { id: 'schedule', cell: [0, 1], role: 'source', manage: 'fork-courses', via: 'Host schedule · fork-courses' },
  { id: 'presence', cell: [0, 6], role: 'source', via: 'focus-watch · ingest source presence' },
  { id: 'monitors', cell: [0, 13], tracks: { sources: ['monitor'] }, role: 'source', title: 'Monitor', via: 'fork-tool-monitor · event source monitor' },
  { id: 'speech', cell: [0, 12], role: 'source', title: '语音输入', wired: 'planned', gap: '图上没有写明语义，代码里没有对应的东西。' },
  {
    id: 'personaIn', cell: [0, 8], role: 'source', title: '风格学习', service: 'style', manage: 'fork-style', wired: 'partial',
    via: 'fork-style · persona preset', gap: '说话风格靠各 preset 里的 persona 组件带进 Session，不是推送的事件。',
  },
  {
    id: 'uploadLocal', cell: [0, 10], tracks: { sources: ['upload'] }, role: 'source', title: '本地视频上传', wired: 'partial',
    via: 'ingest source upload · subscription upload-local',
    gap: '接收端和 Session 已就绪；在另一台机器上发 upload.local.ready 的脚本要主人自己放（RUNBOOK §25）。',
  },
  { id: 'dnd', cell: [1, 6], role: 'core', service: 'dsh', manage: 'fork-presence', via: 'fork-presence' },
  { id: 'deferQ', cell: [4, 1], needs: 'wechat', role: 'core', title: '发送时机', via: 'defer_deliver tool · fork-wechat outbox · fork-presence' },
  {
    id: 'githubSessions', cell: [1, 3], tracks: { subscriptions: ['ci'] }, role: 'agent', title: 'GitHub CI', service: 'dsh', manage: 'fork-agents', wired: 'partial',
    via: 'subscription ci (one Session per repo)', gap: '只接 workflow_run.completed 一种事件；发布、提交不起 Session。',
  },
  {
    id: 'notifySession', cell: [3, 3], tracks: { subscriptions: ['notify-funnel'] }, role: 'agent', title: '通知台', manage: 'fork-subscriptions', wired: 'partial',
    via: 'subscription notify-funnel · preset notify',
    gap: '接主机的非紧急通知和 autocut 待确认、失败，走便宜路由；自动修复和 AMS 的分支还没接进来；紧急的主机告警（磁盘满）仍直接发微信。',
  },
  {
    id: 'qqSessions', cell: [1, 7], needs: 'qq', role: 'agent', title: 'QQ 群摘要', service: 'dsh', manage: 'fork-agents', wired: 'partial',
    via: 'fork-qq digest (one resident Session per group)', gap: '是定时摘要，不向主智能体推事件；主智能体靠 tool-qq 查询。',
  },
  {
    id: 'amsGroup', cell: [1, 5], role: 'agent', title: '服务告警分组', service: 'dsh', manage: 'fork-agents', wired: 'partial',
    via: 'ga-watch journal Monitor', gap: '分组在 Monitor 的闸门里（新问题、12 小时后复发、抖动），不是 DSH 里的 Session。',
  },
  {
    id: 'repairQ', cell: [2, 4], role: 'cond', title: '自动修复？', wired: 'partial', via: 'skill ams-repair (the main agent judges)',
    gap: '判断由主智能体按技能做，不是固定规则；技能随 setup-profile 链接进 DSH_HOME 之后才生效。',
  },
  {
    id: 'repair', cell: [3, 5], role: 'agent', title: '自动修复', manage: 'fork-agents', wired: 'partial', via: 'cc_start · fork-cc-bridge · skill ams-repair',
    gap: '只修到分支为止，测试通过后汇报；部署和重启要主人点头。',
  },
  {
    id: 'qqMain', cell: [2, 8], tracks: { subscriptions: ['qq-main'] }, needs: 'qq', role: 'agent', title: 'QQ 主会话', manage: 'fork-subscriptions', wired: 'partial',
    via: 'subscription qq-main · preset qq-main',
    gap: '读各群摘要并保持跨群上下文；出口 QQ onebot 尚未实现，所以它不开口，回答也不进微信。',
  },
  {
    id: 'autocutQ', cell: [1, 10], tracks: { subscriptions: ['upload-local'] }, role: 'cond', title: '需要剪辑？', wired: 'partial', via: 'subscription upload-local (the Session judges)',
    gap: '“剪不剪”由该会话自己判断；“否”这一支只问主人是否上传，主人说好才交给烤肉。',
  },
  {
    id: 'autocut', cell: [2, 10], tracks: { sources: ['autocut'], subscriptions: ['autocut'] }, role: 'agent', title: '自动剪辑', wired: 'partial', via: 'subscription autocut · autocut skill',
    gap: '事件进专用 Session；失败另汇入通知消息 session；“剪不剪”的判断在 upload-local。',
  },
  { id: 'main', cell: [3, 1], role: 'agent', service: 'dsh', manage: 'fork-agents', via: 'fork-wechat chat Session' },
  { id: 'up', cell: [1, 9], tracks: { subscriptions: ['bili-digest'] }, needs: 'bili', role: 'agent', service: 'dsh', manage: 'fork-agents', via: 'subscription bili-digest · preset up' },
  { id: 'gate', cell: [2, 9], needs: 'bili', role: 'out', service: 'bili', manage: 'bili', via: 'bili-svc Reply Gate' },
  { id: 'cc', cell: [4, 3], role: 'out', service: 'cc', manage: 'fork-agents', via: 'fork-cc-bridge' },
  { id: 'voice', cell: [4, 4], role: 'out', service: 'voice', manage: 'fork-agents', via: 'fork-tool-voice · fork-voice' },
  {
    id: 'persona', cell: [3, 8], role: 'out', title: '说话风格', service: 'style', manage: 'fork-style', wired: 'partial', via: 'fork-style',
    gap: '语气由 fork-style 从 QQ 和 B站 的样本里自动学，不是智能体主动查询。',
  },
  {
    id: 'qqOut', cell: [4, 8], role: 'out', title: 'QQ 发言', manage: 'fork-qq', wired: 'planned',
    gap: '图上已标注尚未实现；fork-qq 按设计只收不发，打开 send.enabled 会加载失败。',
  },
  { id: 'autocutOut', cell: [4, 10], role: 'out', title: '剪辑服务', via: 'autocut skill · autocut-worker' },
  { id: 'wechatOut', cell: [5, 1], needs: 'wechat', role: 'out', service: 'wechat', manage: 'fork-wechat', via: 'fork-wechat · owner-relay' },
  { id: 'biliOut', cell: [5, 9], role: 'out', service: 'bili', manage: 'bili', via: 'bili-svc' },
]

/** Every arrow. */
export const EDGES: readonly FlowEdge[] = [
  { from: 'wechatIn', to: 'main', kind: 'event' },
  { from: 'up', to: 'gate', kind: 'pull' },
  { from: 'gate', to: 'biliOut', kind: 'send' },
  { from: 'main', to: 'cc', kind: 'call' },
  { from: 'github', to: 'githubSessions', kind: 'event' },
  { from: 'presence', to: 'dnd', kind: 'event' },
  { from: 'qq', to: 'qqSessions', kind: 'event' },
  { from: 'qqSessions', to: 'persona', kind: 'pull' },
  { from: 'bili', to: 'persona', kind: 'pull' },
  { from: 'notifySession', to: 'main', kind: 'event' },
  { from: 'qqSessions', to: 'main', kind: 'event' },
  { from: 'host', to: 'notifySession', kind: 'event' },
  { from: 'monitors', to: 'notifySession', kind: 'event' },
  { from: 'operator', to: 'main', kind: 'event' },
  { from: 'main', to: 'voice', kind: 'event' },
  { from: 'speech', to: 'main', kind: 'event' },
  { from: 'main', to: 'wechatOut', kind: 'event' },
  { from: 'personaIn', to: 'up', kind: 'event' },
  { from: 'bili', to: 'up', kind: 'event' },
  { from: 'ams', to: 'amsGroup', kind: 'event' },
  { from: 'amsGroup', to: 'repairQ', kind: 'event' },
  { from: 'repairQ', to: 'repair', kind: 'event', branch: 'yes' },
  { from: 'repair', to: 'notifySession', kind: 'event' },
  { from: 'personaIn', to: 'qqSessions', kind: 'event' },
  { from: 'personaIn', to: 'qqMain', kind: 'event' },
  { from: 'qqSessions', to: 'qqMain', kind: 'event' },
  { from: 'qqMain', to: 'qqOut', kind: 'pull' },
  { from: 'repairQ', to: 'notifySession', kind: 'event', branch: 'no' },
  { from: 'schedule', to: 'main', kind: 'event' },
  { from: 'dnd', to: 'deferQ', kind: 'event' },
  { from: 'main', to: 'deferQ', kind: 'event' },
  { from: 'deferQ', to: 'wechatOut', kind: 'event' },
  { from: 'voice', to: 'wechatOut', kind: 'event' },
  { from: 'githubSessions', to: 'repairQ', kind: 'event' },
  { from: 'autocut', to: 'notifySession', kind: 'event' },
  { from: 'main', to: 'autocutOut', kind: 'event' },
  { from: 'pipelines', to: 'amsGroup', kind: 'event' },
  { from: 'uploadLocal', to: 'autocutQ', kind: 'event' },
  { from: 'autocutQ', to: 'autocut', kind: 'event', branch: 'yes' },
  { from: 'autocut', to: 'biliOut', kind: 'event' },
  { from: 'autocutQ', to: 'biliOut', kind: 'event', branch: 'no' },
  { from: 'autocut', to: 'amsGroup', kind: 'send' },
  { from: 'autocut', to: 'voice', kind: 'pull' },
  { from: 'qqMain', to: 'voice', kind: 'pull' },
]

/** The whole picture, laid out once, with what is not built yet. */
export const GRAPH = buildGraph(NODES, EDGES)

const BUILT = NODES.filter(node => node.wired !== 'planned')
const BUILT_IDS = new Set(BUILT.map(node => node.id))
/** The picture the page opens with: only what exists. */
export const GRAPH_BUILT = buildGraph(BUILT, EDGES.filter(edge => BUILT_IDS.has(edge.from) && BUILT_IDS.has(edge.to)))
/** How many boxes {@link GRAPH_BUILT} leaves out. */
export const PLANNED_COUNT = NODES.length - BUILT.length
