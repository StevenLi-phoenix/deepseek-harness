/** The output schema and renderers the fork's JSON tools share. */

/** The output schema of a tool's refusal: `{ error }`. */
export const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { error: { type: 'string', required: true } },
} as const

/** One rendered text block. */
type TextBlocks = [{ type: 'text'; text: string }]

/**
 * Render a tool's value as its JSON text.
 * @param _args - the call's arguments; unused.
 * @param value - the value.
 * @returns one text block.
 */
export function renderJson(_args: unknown, value: unknown): TextBlocks {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/**
 * A renderer that shows a refusal `{ error: string }` as its JSON and wraps any other value, for tools whose values
 * carry other people's words.
 * @param wrap - turns a value into the block the model reads.
 * @returns the renderer.
 */
export function renderWrapped(wrap: (value: unknown) => string): (args: unknown, value: unknown) => TextBlocks {
  return (_args, value) => {
    const error = (value as { error?: unknown } | null)?.error
    return [{ type: 'text', text: typeof error === 'string' ? JSON.stringify({ error }) : wrap(value) }]
  }
}
