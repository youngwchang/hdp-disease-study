const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

const EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const parser = new XMLParser({ ignoreAttributes: false });

/** PubMed 검색 후 논문 목록 반환 */
async function search(query, maxResults = 10, filter = '') {
  try {
    // 1단계: ID 목록 검색
    const searchTerm = filter ? `${query} AND ${filter}` : query;
    const searchResp = await axios.get(`${EUTILS_BASE}/esearch.fcgi`, {
      params: {
        db: 'pubmed',
        term: searchTerm,
        retmax: maxResults,
        retmode: 'json',
        sort: 'relevance',
      },
      timeout: 15000,
    });

    const ids = searchResp.data.esearchresult?.idlist || [];
    if (ids.length === 0) return [];

    // 2단계: 초록 포함 메타데이터 수집
    await sleep(400); // rate limit 준수
    const fetchResp = await axios.get(`${EUTILS_BASE}/efetch.fcgi`, {
      params: {
        db: 'pubmed',
        id: ids.join(','),
        rettype: 'abstract',
        retmode: 'xml',
      },
      timeout: 20000,
    });

    return parseXmlArticles(fetchResp.data);
  } catch (err) {
    console.warn(`[PubMed] 검색 실패 (${query}):`, err.message);
    return [];
  }
}

function parseXmlArticles(xmlText) {
  try {
    const parsed = parser.parse(xmlText);
    const articles = parsed?.PubmedArticleSet?.PubmedArticle || [];
    const list = Array.isArray(articles) ? articles : [articles];

    return list.map(article => {
      const medline = article?.MedlineCitation;
      const pmid = medline?.PMID?.['#text'] || medline?.PMID || '';
      const articleData = medline?.Article || {};
      const title = articleData?.ArticleTitle?.['#text'] || articleData?.ArticleTitle || '';
      const abstract = extractAbstract(articleData?.Abstract);
      const journal = articleData?.Journal?.Title || '';
      const year = articleData?.Journal?.JournalIssue?.PubDate?.Year || '';
      const authors = extractAuthors(articleData?.AuthorList?.Author);

      return { pmid: String(pmid), title, abstract, authors, year: String(year), journal };
    }).filter(a => a.title);
  } catch {
    return [];
  }
}

function extractAbstract(abstractNode) {
  if (!abstractNode) return '';
  const text = abstractNode?.AbstractText;
  if (typeof text === 'string') return text.substring(0, 600);
  if (Array.isArray(text)) return text.map(t => t['#text'] || t).join(' ').substring(0, 600);
  return String(text || '').substring(0, 600);
}

function extractAuthors(authorNode) {
  if (!authorNode) return '';
  const list = Array.isArray(authorNode) ? authorNode : [authorNode];
  return list.slice(0, 3).map(a => `${a.LastName || ''} ${a.Initials || ''}`.trim()).filter(Boolean).join(', ');
}

/** 논문 목록을 프롬프트용 텍스트로 변환 */
function formatForPrompt(papers, label = '논문') {
  if (!papers || papers.length === 0) return `${label}: 검색 결과 없음`;
  return papers.map((p, i) =>
    `[${label} ${i + 1}] PMID: ${p.pmid}\n제목: ${p.title}\n저자: ${p.authors} (${p.year}) | ${p.journal}\n초록: ${p.abstract}\n`
  ).join('\n---\n');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { search, formatForPrompt };
