/**
 * Personal information in a channel note. A note describes the channel's audience, its vibe, and recurring topics;
 * any text that names, numbers, or locates a person is refused. Deterministic patterns only; no model judges a note.
 */

/** Kinds of personal information a channel note may not carry, each with its own rule. */
export const PII_KINDS = ['name', 'uid', 'phone', 'email', 'address', 'org', 'place', 'handle'] as const
/** One of {@link PII_KINDS}. */
export type PiiKind = typeof PII_KINDS[number]

// Specific patterns first: a phone number is not also reported as a UID.
const PII_RULES: ReadonlyArray<readonly [PiiKind, RegExp]> = [
  // A name with an honorific, a self-introduction, a named person, or a Latin full name.
  ['name', /\p{Script=Han}{1,3}(?:老师|同学|先生|女士|小姐|教授|经理|学长|学姐|哥哥|姐姐)|(?:我叫|名叫|叫做|真名|本名|名字是)\s*[\p{Script=Han}A-Za-z]{2,}|\b[A-Z][a-z]+ [A-Z][a-z]+\b/u],
  ['phone', /(?<!\d)1[3-9]\d{9}(?!\d)|\d{3,4}-\d{7,8}|(?:手机|电话|微信|vx|qq)\s*[号:：]?\s*[\w-]{5,}/iu],
  // An account number: labeled, or any run of five or more digits.
  ['uid', /\b(?:uid|mid)\s*[:：=]?\s*\d{3,}|(?<!\d)\d{5,}(?!\d)/iu],
  ['email', /[\w.+-]+\s*[@＠]\s*[\w-]+(?:\.[\w-]+)+/u],
  ['address', /\p{Script=Han}{1,8}(?:路|街|巷|弄|小区|公寓|大厦|栋|单元)\d*号?|\d+号楼|门牌|宿舍/u],
  // School or employer.
  ['org', /[\p{Script=Han}A-Za-z]{1,10}(?:大学|学院|中学|小学|高中|初中|公司|集团|研究所|研究院|医院|银行)|在[\p{Script=Han}A-Za-z]{1,8}(?:上学|读书|工作|上班)/u],
  // A place tied to a person: where someone lives or comes from.
  ['place', /(?:住在|家在|老家|坐标|定位)\s*[\p{Script=Han}a-z]{2,}|(?:人在|我在|他在|她在|ta在|来自)[\p{Script=Han}]{1,6}(?:省|市|区|县|镇|村)/iu],
  ['handle', /[@＠]\S+/u],
]

/**
 * The first kind of personal information a text carries.
 * @param text - one channel note.
 * @returns the kind, or undefined when none is found.
 */
export function piiKind(text: string): PiiKind | undefined {
  const folded = text.normalize('NFKC')
  return PII_RULES.find(([, rule]) => rule.test(folded))?.[0]
}
