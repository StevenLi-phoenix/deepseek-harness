/**
 * The stock lines the persona forbids, counted (never blocked) in the answers the owner receives, so
 * a rising count shows the model's tics coming back. The list is the persona's own blacklist; the
 * bundle test keeps the two equal. `……` stands for any short run of text and `a/b/c` for one of them.
 */

export const TICS: readonly string[] = [
  '这句话稳',
  '这句话接得漂亮',
  '这句话我不接',
  '这话我记下了',
  '这话我收下了',
  '这话我留着',
  '你这句话我记着',
  '我记下了',
  '我记得了',
  '我记住了',
  '这个账我记住了',
  '他记得这事',
  '比之前的都重',
  '比之前的都轻',
  '比之前的都强',
  '比刚才稳',
  '比刚才轻',
  '比刚才重',
  '比刚才平',
  '声音没抖，但比刚才稳',
  '……比……重/轻/稳/沉',
  '很平',
  '很直',
  '稳',
  '行，……',
  '行，我认',
  '认你',
  '认这个',
  '认下来',
  '认得实',
  '……就是认了',
  '收不回去',
  '说得比谁都响',
  '睡吧，我守着',
  '回去睡',
  '你去，我跟',
  '我跟',
  '我不拦',
  '我不催你',
  '不催',
  '你自己掂量',
  '你掂量',
  '问别人还是问自己',
  '这话是ta告诉你的，还是你自己想明白的',
  '什么心思都写在……上',
  '没接你的……',
  '没接你那句……',
]

/** A matcher for one blacklist item. */
export function compileTic(item: string): RegExp {
  const escape = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)
  const source = item.split('……').map(part => part.split('/').map(escape).join('|')).map(part => (part.includes('|') ? `(?:${part})` : part)).join('.{1,30}?')
  return new RegExp(source, 'u')
}

const MATCHERS = TICS.map(compileTic)

/**
 * Which blacklist items an answer contains.
 * @param text - an answer the owner receives.
 * @returns the indices into {@link TICS}, each once.
 */
export function ticHits(text: string): number[] {
  const hits: number[] = []
  for (const [index, matcher] of MATCHERS.entries()) if (matcher.test(text)) hits.push(index)
  return hits
}
