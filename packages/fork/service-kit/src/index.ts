/**
 * Host helpers the fork's long-running services and tools share: tracked background work and an abortable pause, the
 * Sessions a channel opens and hands to the owner relay, a JSON Settings route's body and errors, one model call
 * without a Session, and the output of JSON tools. Functions and per-caller instances only, with no module state.
 *
 * @module @deepseek-ai/dsh-service-kit
 */

export {
  forgetOldest, joinRelay, openPresetSession, unavailableReason, type PresetSession, type RelayRegistry, type RememberedSessions,
} from './chat-session.ts'
export { jsonFailure, NO_STORE, readJsonAction, readJsonBody } from './json-route.ts'
export { callModelOnce, type OneShotAnswer, type OneShotRequest, type OneShotSettings } from './model-call.ts'
export { ERROR_SCHEMA, renderJson, renderWrapped } from './tool-output.ts'
export { BackgroundWork, pause, type WakeSlot } from './work.ts'
