const numberWordValues: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  один: 1,
  одна: 1,
  одно: 1,
  одного: 1,
  одной: 1,
  одну: 1,
  два: 2,
  две: 2,
  двух: 2,
  три: 3,
  трех: 3,
  трёх: 3,
  четыре: 4,
  четырех: 4,
  четырёх: 4,
  пять: 5,
  пяти: 5,
  шесть: 6,
  шести: 6,
  семь: 7,
  семи: 7,
  восемь: 8,
  восьми: 8,
  девять: 9,
  девяти: 9,
  десять: 10,
  десяти: 10,
  одиннадцать: 11,
  одиннадцати: 11,
  двенадцать: 12,
  двенадцати: 12,
  тринадцать: 13,
  тринадцати: 13,
  четырнадцать: 14,
  четырнадцати: 14,
  пятнадцать: 15,
  пятнадцати: 15,
  шестнадцать: 16,
  шестнадцати: 16,
  семнадцать: 17,
  семнадцати: 17,
  восемнадцать: 18,
  восемнадцати: 18,
  девятнадцать: 19,
  девятнадцати: 19,
  двадцать: 20,
};

const numberTokenSource = `(?:\\d+|${Object.keys(numberWordValues)
  .sort((left, right) => right.length - left.length)
  .join("|")})`;
const numberChainSource = `${numberTokenSource}(?:\\s*(?:[-–—]|до|to|или|либо|or|and|и)\\s*${numberTokenSource})*`;
const slideWordSource = "(?:слайд(?:а|ов|ы|е|ам|ами|ах)?|slides?)";
const beforeSlidePattern = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])(${numberChainSource})[\\s,;:–—-]+${slideWordSource}(?=$|[^\\p{L}\\p{N}])`,
  "giu",
);
const afterSlidePattern = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])${slideWordSource}(?:\\s*(?:[:=—–]\\s*|\\s+(?:должно\\s+быть|должен\\s+быть|должны\\s+быть|будет|будут|составит|составят|равно|всего|ровно|should\\s+be|will\\s+be)\\s+|\\s+))(${numberChainSource})(?=$|[^\\p{L}\\p{N}])`,
  "giu",
);
const numberTokenPattern = new RegExp(numberTokenSource, "giu");

export type EffectiveSlideCount = {
  count: number;
  source: "brief" | "selection";
};

export function resolveEffectiveSlideCount(
  brief: string,
  selectedCount: number,
): EffectiveSlideCount {
  const counts = new Set<number>();
  collectCounts(brief, beforeSlidePattern, counts);
  collectCounts(brief, afterSlidePattern, counts);

  if (counts.size === 1) {
    const [count] = counts;
    if (count !== undefined && count >= 5 && count <= 15) {
      return { count, source: "brief" };
    }
  }

  return { count: selectedCount, source: "selection" };
}

function collectCounts(brief: string, pattern: RegExp, counts: Set<number>) {
  for (const match of brief.matchAll(pattern)) {
    const numberChain = match[1];
    if (!numberChain) continue;
    for (const tokenMatch of numberChain.matchAll(numberTokenPattern)) {
      const count = parseNumberToken(tokenMatch[0]);
      if (count !== null) counts.add(count);
    }
  }
}

function parseNumberToken(token: string): number | null {
  if (/^\d+$/u.test(token)) {
    const value = Number(token);
    return Number.isSafeInteger(value) ? value : null;
  }
  return numberWordValues[token.toLocaleLowerCase()] ?? null;
}
