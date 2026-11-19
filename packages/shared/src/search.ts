/** 낱말 검색 (gateway의 mcp_search와 memory의 노트 검색이 같이 쓴다). embedding이나 색인 서버는 쓰지 않는다. */

/** 소문자 낱말. 한글은 조사가 붙어도 맞도록 두 글자씩 자른다 (`결함을` → `결함`, `함을`). */
export function searchTerms(text: string): string[] {
  const terms: string[] = [];
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    if (!/\p{Script=Hangul}/u.test(word) || word.length <= 2) {
      terms.push(word);
      continue;
    }
    for (let i = 0; i < word.length - 1; i++) terms.push(word.slice(i, i + 2));
  }
  return terms;
}

/**
 * Okapi BM25 (k1 1.2, b 0.75). 문서를 `add`로 하나씩 넣고, `scores`가 넣은 순서대로 점수를 준다 (0이면 맞는 낱말이 없다).
 * 문서의 글은 들고 있지 않는다: 길이와 query 낱말이 나온 횟수만 남긴다.
 */
export function bm25(query: string) {
  const queryTerms = [...new Set(searchTerms(query))];
  const position = new Map(queryTerms.map((term, i) => [term, i]));
  const documents: { length: number; counts: number[] }[] = [];
  return {
    /** 문서에 query 낱말이 하나라도 있으면 true */
    add(text: string): boolean {
      const counts = queryTerms.map(() => 0);
      const terms = searchTerms(text);
      let matched = false;
      for (const term of terms) {
        const i = position.get(term);
        if (i === undefined) continue;
        counts[i]!++;
        matched = true;
      }
      documents.push({ length: terms.length, counts });
      return matched;
    },
    scores(): number[] {
      // 빈 문서는 평균 길이에 넣지 않는다 (태그처럼 대개 비어 있는 글에서 평균이 0에 가까워지지 않게).
      const filled = documents.filter((d) => d.length > 0);
      const average = filled.reduce((sum, d) => sum + d.length, 0) / filled.length || 1;
      const idf = queryTerms.map((_, i) => {
        const frequency = documents.filter((d) => d.counts[i]! > 0).length;
        return Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5));
      });
      return documents.map((d) =>
        d.counts.reduce((score, count, i) => (count ? score + (idf[i]! * (count * 2.2)) / (count + 1.2 * (0.25 + (0.75 * d.length) / average)) : score), 0),
      );
    },
  };
}
