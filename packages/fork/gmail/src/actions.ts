/**
 * The label changes `ctx.gmail.modify()` accepts.
 */

/** What a label change does. */
export type ModifyAction = 'read' | 'unread' | 'archive' | 'inbox' | 'star' | 'unstar' | 'trash' | 'untrash' | 'label' | 'unlabel'

/** Every label change, in the order the tool lists them. */
export const MODIFY_ACTIONS: readonly ModifyAction[] = ['read', 'unread', 'archive', 'inbox', 'star', 'unstar', 'trash', 'untrash', 'label', 'unlabel']
