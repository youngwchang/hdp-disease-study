const { callClaude } = require('../lib/claude');
const pubmed = require('../lib/pubmed');
const hira = require('../lib/hira');

const SYSTEM = `당신은 제약사 BD팀의 전문 역학 리서처입니다.
질환의 글로벌·국내 역학 데이터를 수집하고 분석합니다.
- 모든 수치에 출처(기관명)와 연도를 반드시 명시하세요.
- WHO, IHME GBD, OECD 등 공인 기관 데이터를 우선 인용하세요.
- 수치 없는 항목은 "공개 데이터 미확인"으로 표기하세요.
- 마크다운 테이블 형식을 사용하세요.`;

async function run(context, emit) {
  emit('Epidemiology Agent: HIRA + PubMed 검색 중...');

  const { disease_name_ko: ko, disease_name_en: en, icd_code: icd, synonyms, search_keywords } = context;
  const enKeywords = search_keywords?.en || [en];

  const [epiPapers, burdenPapers, hiraData] = await Promise.all([
    pubmed.search(`${en} prevalence incidence epidemiology`, 8, 'systematic review[pt] OR meta-analysis[pt]'),
    pubmed.search(`${en} burden of disease DALY mortality`, 5),
    hira.search(icd, [2020, 2021, 2022, 2023]),
  ]);

  emit('Epidemiology Agent: Claude 분석 중 (역학 섹션)...');

  const userPrompt = `## 분석 대상 질환
- 한국어명: ${ko}
- 영문명: ${en} (동의어: ${synonyms.join(', ')})
- ICD-10: ${icd}

## 사전 수집된 데이터

### PubMed 역학 문헌 (메타분석·체계적 문헌고찰 우선)
${pubmed.formatForPrompt(epiPapers, '역학')}

### PubMed 질환 부담 문헌
${pubmed.formatForPrompt(burdenPapers, '질환부담')}

### HIRA 건강보험 청구 데이터
${hira.formatForPrompt(hiraData)}

## 웹 검색 보완 지침
다음을 웹 검색으로 반드시 보완하세요:
- WHO/IHME GBD 글로벌 유병률·환자수 추정치
- 한국 질병관리청(KDCA) 국민건강영양조사 데이터
- 국내 학회 Fact Sheet 또는 통계 자료
- 검색어: "${en} WHO global prevalence 2023", "${ko} 질병관리청 통계", "${en} IHME burden disease"

## 출력 형식

===SECTION5===
## 5. 역학 데이터 (글로벌 / 한국)

### 5-1. 글로벌 유병률 및 환자수

| 지역 | 유병률 또는 환자수 | 연도 | 출처(기관명) |
|------|----------------|------|------------|
| 전 세계 | ... | ... | WHO/IHME 등 |
| 북미 | ... | ... | ... |
| 유럽 | ... | ... | ... |
| 아시아·태평양 | ... | ... | ... |

**추정치 범위**: 최솟값 ~ 최댓값 (출처 간 차이 원인: ...)

### 5-2. 국내 현황

#### HIRA 건강보험 청구 데이터
| 연도 | 청구 환자수(명) | 입원 | 외래 |
|------|-------------|------|------|
[HIRA 데이터 또는 "HIRA 데이터 미확인"]

> ⚠️ HIRA 청구 기반 — 무증상·미진단 환자 미포함으로 실제보다 과소 추정 가능

#### 질병관리청(KDCA) 통계
[국민건강영양조사·만성질환통계 수치 또는 "KDCA 해당 통계 미확인"]

### 5-3. 연령·성별 분포
[분포 서술 또는 "데이터 미확인"]

### 5-4. 질환 부담 지표
| 지표 | 수치 | 연도 | 출처 |
|------|------|------|------|
| DALY | ... | ... | ... |
| 사망률 | ... | ... | ... |

### 5-5. 데이터 해석 주의사항
[추정치 차이 원인 및 데이터 한계]
===END_SECTION5===`;

  const response = await callClaude(SYSTEM, userPrompt, true, 6000);
  return parseSection(response);
}

function parseSection(text) {
  const match = text.match(/===SECTION5===([\s\S]*?)===END_SECTION5===/);
  if (match) return match[1].trim();
  const fallback = text.match(/(## 5\.[\s\S]*)/);
  return fallback ? fallback[1].trim() : text.trim();
}

module.exports = { run };
