/** Workspace navigation configuration shared by the Host and Client faces; types only. */
import type { Volatile } from '@deepseek-ai/cordis'

/** Live Workspace navigation preferences; the browser receives every field through its synced Config. */
export interface WorkspaceNavigationConfig {
  /** Recently viewed Sessions needing no attention kept loaded besides the main-view Session. */
  recentViewLimit: Volatile<number>
  /**
   * Agent preset ids whose Sessions the sidebar's session-type choice counts
   * as automated, for channels that prompt through the user path on behalf of
   * others; Sessions no person prompted count as automated regardless.
   */
  automatedAgentPresets: Volatile<string[]>
}
