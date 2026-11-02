/**
 * The event service's data flow as a graph: where an event comes from, what it passes through, and where an answer goes.
 * The topology is written down here, drawn in the flow editor and exported from it (`nodes` and `edges` of its JSON); it is
 * the owner's picture of the flow, so a box may name something not wired yet. A hexagonal `cond` box asks a question and its
 * arrows carry the answer. The Flow page lays it out from the edges alone, so a new edge moves the nodes by itself, and
 * `flow-graph.client.spec.ts` fails on a cycle, a dangling arrow, or a question without both answers. Pure data.
 */

import { buildGraph, type FlowEdge, type FlowNode } from './flow-model.ts'

/** Every box, in the order that breaks ties inside a column. */
export const NODES: readonly FlowNode[] = [
  { id: 'wechatIn', role: 'source', service: 'wechat', manage: 'lsy-wechat' },
  { id: 'qq', role: 'source', service: 'qq', manage: 'lsy-qq' },
  { id: 'bili', role: 'source', service: 'bili', manage: 'bili' },
  { id: 'github', role: 'source' },
  { id: 'pipelines', role: 'source' },
  { id: 'host', role: 'source' },
  { id: 'ams', role: 'source', service: 'ams' },
  { id: 'operator', role: 'source' },
  { id: 'schedule', role: 'source', manage: 'lsy-courses' },
  { id: 'presence', role: 'source' },
  { id: 'speech', role: 'source', title: '语音输出' },
  { id: 'personaIn', role: 'source', title: 'Persona', service: 'style', manage: 'lsy-style' },
  { id: 'uploadLocal', role: 'source', title: 'bilibili upload from local' },
  { id: 'dnd', role: 'core', service: 'dsh', manage: 'lsy-presence' },
  { id: 'merge', role: 'core', title: 'merge 定时任务 + 勿扰状态' },
  { id: 'deferQ', role: 'core', title: 'defer delay?' },
  { id: 'githubSessions', role: 'agent', title: 'Github Sessions Group By repo', service: 'dsh', manage: 'lsy-agents' },
  { id: 'notifySession', role: 'agent', title: '通知消息 session', service: 'bus', manage: 'lsy-subscriptions' },
  { id: 'qqSessions', role: 'agent', title: 'QQ sessions group by ids', service: 'dsh', manage: 'lsy-agents' },
  { id: 'amsGroup', role: 'agent', title: 'AMS msg group', service: 'dsh', manage: 'lsy-agents' },
  { id: 'repairQ', role: 'cond', title: '自动修复' },
  { id: 'repair', role: 'agent', title: '自动修复', service: 'dsh', manage: 'lsy-agents' },
  { id: 'qqMain', role: 'agent', title: 'shared QQ main session (iso)', service: 'dsh', manage: 'lsy-agents' },
  { id: 'autocutQ', role: 'cond', title: 'Autocut?' },
  { id: 'autocut', role: 'agent', title: 'autocut' },
  { id: 'main', role: 'agent', service: 'dsh', manage: 'lsy-agents' },
  { id: 'up', role: 'agent', service: 'dsh', manage: 'lsy-agents' },
  { id: 'gate', role: 'out', service: 'bili', manage: 'bili' },
  { id: 'cc', role: 'out', service: 'cc', manage: 'lsy-agents' },
  { id: 'voice', role: 'out', service: 'voice', manage: 'lsy-agents' },
  { id: 'persona', role: 'out', title: 'Persona', service: 'style', manage: 'lsy-style' },
  { id: 'qqOut', role: 'out', title: 'QQ onebot', service: 'qq', manage: 'lsy-qq' },
  { id: 'autocutOut', role: 'out', title: 'autocut' },
  { id: 'wechatOut', role: 'out', service: 'wechat', manage: 'lsy-wechat' },
  { id: 'biliOut', role: 'out', service: 'bili', manage: 'bili' },
]

/** Every arrow. */
export const EDGES: readonly FlowEdge[] = [
  { from: 'wechatIn', to: 'main', kind: 'event' },
  { from: 'up', to: 'gate', kind: 'pull' },
  { from: 'gate', to: 'biliOut', kind: 'send' },
  { from: 'main', to: 'cc', kind: 'call' },
  { from: 'github', to: 'githubSessions', kind: 'event' },
  { from: 'presence', to: 'notifySession', kind: 'event' },
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
  { from: 'schedule', to: 'merge', kind: 'event' },
  { from: 'dnd', to: 'merge', kind: 'event' },
  { from: 'merge', to: 'main', kind: 'event' },
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
