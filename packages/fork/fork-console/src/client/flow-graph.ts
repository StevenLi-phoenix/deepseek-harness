/**
 * The event service's data flow as a graph: where an event comes from, what it passes through, and where an answer goes.
 * The topology is written down here, drawn in the flow editor and exported from it (`nodes` and `edges` of its JSON); it is
 * the owner's picture of the flow, so a box may name something not wired yet. A hexagonal `cond` box asks a question and its
 * arrows carry the answer. The Flow page lays it out from the edges alone, so a new edge moves the nodes by itself, and
 * `flow-graph.client.spec.ts` fails on a cycle, a dangling arrow, or a question without both answers. Pure data.
 */

import { buildGraph, type FlowEdge, type FlowNode } from './flow-model.ts'

/**
 * Every box, in the order that breaks ties inside a column. `wired`, `via` and `gap` say how far the running service matches the
 * drawing: a box with none is live, one marked `partial` is wired differently or in part, and `planned` is not built. `via` names
 * what carries it as plain identifiers; `gap` says in the owner's words how the service differs.
 */
export const NODES: readonly FlowNode[] = [
  { id: 'wechatIn', role: 'source', service: 'wechat', manage: 'fork-wechat', via: 'fork-wechat' },
  { id: 'qq', role: 'source', service: 'qq', manage: 'fork-qq', via: 'fork-qq · qq-recorder' },
  { id: 'bili', role: 'source', service: 'bili', manage: 'bili', via: 'bili-svc · ingest source bili' },
  { id: 'github', role: 'source', via: 'fork-github-sensor · webhook-github' },
  {
    id: 'pipelines', role: 'source', wired: 'partial', via: 'ingest source kaorou · subscription kaorou',
    gap: '图上连向 AMS 分组；实际由 kaorou 订阅每批起一个 Session，不经 AMS。',
  },
  { id: 'host', role: 'source', via: 'ingest source host · subscriptions host-alerts, notify-funnel' },
  { id: 'ams', role: 'source', service: 'ams', via: 'AMS escalation journal' },
  {
    id: 'operator', role: 'source', wired: 'partial', via: 'ingest source operator · subscription operator',
    gap: '实际是独立的 Session，答案经 owner-relay 发到微信，不进主聊天 Session。',
  },
  { id: 'schedule', role: 'source', manage: 'fork-courses', via: 'Host schedule · fork-courses' },
  { id: 'presence', role: 'source', via: 'focus-watch · ingest source presence' },
  { id: 'speech', role: 'source', title: '语音输出', wired: 'planned', gap: '图上没有写明语义，代码里没有对应的东西。' },
  {
    id: 'personaIn', role: 'source', title: 'Persona', service: 'style', manage: 'fork-style', wired: 'partial',
    via: 'fork-style · persona preset', gap: '说话风格靠各 preset 里的 persona 组件带进 Session，不是推送的事件。',
  },
  {
    id: 'uploadLocal', role: 'source', title: 'bilibili upload from local', wired: 'planned',
    gap: '还没有本地上传的来源；视频现在由 kaorou 或主人在微信里给链接开始。',
  },
  { id: 'dnd', role: 'core', service: 'dsh', manage: 'fork-presence', via: 'fork-presence' },
  {
    id: 'deferQ', role: 'core', title: 'defer delay?', wired: 'partial', via: 'fork-wechat outbox · fork-presence',
    gap: '现在由勿扰状态按紧急 kind 自动扣住；还没有 defer_deliver 工具。',
  },
  {
    id: 'githubSessions', role: 'agent', title: 'Github Sessions Group By repo', service: 'dsh', manage: 'fork-agents', wired: 'partial',
    via: 'subscription ci (one Session per repo)', gap: '只接 workflow_run.completed 一种事件；发布、提交不起 Session。',
  },
  {
    id: 'notifySession', role: 'agent', title: '通知消息 session', service: 'bus', manage: 'fork-subscriptions', wired: 'partial',
    via: 'subscription notify-funnel · preset notify',
    gap: '只接主机的非紧急通知和 autocut 失败；自动修复和 AMS 的分支还没接进来；紧急的主机告警（磁盘满）仍直接发微信。',
  },
  {
    id: 'qqSessions', role: 'agent', title: 'QQ sessions group by ids', service: 'dsh', manage: 'fork-agents', wired: 'partial',
    via: 'fork-qq digest (one resident Session per group)', gap: '是定时摘要，不向主智能体推事件；主智能体靠 tool-qq 查询。',
  },
  {
    id: 'amsGroup', role: 'agent', title: 'AMS msg group', service: 'dsh', manage: 'fork-agents', wired: 'partial',
    via: 'ga-watch journal Monitor', gap: '分组在 Monitor 的闸门里（新问题、12 小时后复发、抖动），不是 DSH 里的 Session。',
  },
  { id: 'repairQ', role: 'cond', title: '自动修复', wired: 'planned', gap: '没有对应的判断；现在是主智能体读到告警后自己决定。' },
  { id: 'repair', role: 'agent', title: '自动修复', manage: 'fork-agents', wired: 'planned', gap: '没有专门的修复智能体；主智能体可以用 cc_start 起 Claude Code。' },
  {
    id: 'qqMain', role: 'agent', title: 'shared QQ main session (iso)', manage: 'fork-agents', wired: 'planned',
    gap: '还没有跨群共用、与微信隔离的 QQ 主会话。',
  },
  { id: 'autocutQ', role: 'cond', title: 'Autocut?', wired: 'planned', gap: '没有“剪不剪”的判断。' },
  {
    id: 'autocut', role: 'agent', title: 'autocut', wired: 'partial', via: 'subscription autocut · autocut skill',
    gap: '事件进专用 Session；失败另汇入通知消息 session；没有“剪不剪”的判断。',
  },
  { id: 'main', role: 'agent', service: 'dsh', manage: 'fork-agents', via: 'fork-wechat chat Session' },
  { id: 'up', role: 'agent', service: 'dsh', manage: 'fork-agents', via: 'subscription bili-digest · preset up' },
  { id: 'gate', role: 'out', service: 'bili', manage: 'bili', via: 'bili-svc Reply Gate' },
  { id: 'cc', role: 'out', service: 'cc', manage: 'fork-agents', via: 'fork-cc-bridge' },
  { id: 'voice', role: 'out', service: 'voice', manage: 'fork-agents', via: 'fork-tool-voice · fork-voice' },
  {
    id: 'persona', role: 'out', title: 'Persona', service: 'style', manage: 'fork-style', wired: 'partial', via: 'fork-style',
    gap: '语气由 fork-style 从 QQ 和 B站 的样本里自动学，不是智能体主动查询。',
  },
  {
    id: 'qqOut', role: 'out', title: 'QQ onebot', manage: 'fork-qq', wired: 'planned',
    gap: '图上已标注尚未实现；fork-qq 按设计只收不发，打开 send.enabled 会加载失败。',
  },
  { id: 'autocutOut', role: 'out', title: 'autocut', via: 'autocut skill · autocut-worker' },
  { id: 'wechatOut', role: 'out', service: 'wechat', manage: 'fork-wechat', via: 'fork-wechat · owner-relay' },
  { id: 'biliOut', role: 'out', service: 'bili', manage: 'bili', via: 'bili-svc' },
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

/** The page's graph, laid out once. */
export const GRAPH = buildGraph(NODES, EDGES)
