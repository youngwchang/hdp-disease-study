const { callClaude } = require('../lib/claude');
const pubmed = require('../lib/pubmed');

const SYSTEM = `당신은 제약사 BD(사업개발)팀의 전문 임상 리서처입니다.
질환의 임상 정보를 수집하고 분석하여 전략 리포트용 섹션을 작성합니다.
- 인용 원문(영어 가이드라인·논문 제목 등)은 영어를 유지하되, 설명과 요약은 모두 한국어로 작성합니다.
- 수집된 PubMed 데이터와 웹 검색을 모두 적극 활용하세요.
- 정보가 불명확한 경우 "정보 미확인"으로 표기하고 추측하지 않습니다.
- 테이블 형식은 마크다운으로 작성합니다.`;

async function run(diseaseInfo, emit) {
  emit('Clinical Agent: PubMed 문헌 검색 중...');

  const { ko, en, icd, synonyms } = diseaseInfo;
  const synonymStr = synonyms.join(' OR ');

  // 병렬 PubMed 검색
  const [guidelinePapers, diagnosisPapers, treatmentPapers, drugPapers, koreaGuide] = await Promise.all([
    pubmed.search(`${en} practice guideline recommendation`, 8, 'guideline[pt]'),
    pubmed.search(`${en} diagnosis criteria diagnostic workup`, 6),
    pubmed.search(`${en} treatment first-line second-line therapy`, 6),
    pubmed.search(`${en} approved drugs pharmacotherapy`, 6),
    pubmed.search(`${en} Korea Korean guideline`, 4),
  ]);

  emit('Clinical Agent: Claude 분석 중 (가이드라인·진단·치료·약제)...');

  const userPrompt = `## 분석 대상 질환
- 한국어명: ${ko}
- 영문명: ${en}
- ICD-10: ${icd}
- 동의어/약어: ${synonyms.join(', ')}

## 사전 수집된 PubMed 데이터

### 가이드라인 논문
${pubmed.formatForPrompt(guidelinePapers, '가이드라인')}

### 한국 가이드라인 논문
${pubmed.formatForPrompt(koreaGuide, '한국가이드라인')}

### 진단 논문
${pubmed.formatForPrompt(diagnosisPapers, '진단')}

### 치료 논문
${pubmed.formatForPrompt(treatmentPapers, '치료')}

### 약제 논문
${pubmed.formatForPrompt(drugPapers, '약제')}

## 작성 지침
웹 검색을 통해 다음을 반드시 보완하세요:
- 미국 주요 학회(질환 카테고리에 맞게 선택) 최신 가이드라인
- 유럽 주요 학회 가이드라인
- WHO 가이드라인 (있는 경우)
- 한국 학회 가이드라인 (한국어 검색도 시도: "${ko} 진료지침")
- FDA/EMA 허가 약제 현황

## 출력 형식 (반드시 아래 구분자 그대로 사용)

===SECTIONS===
## 1. 질환 개요 및 임상 배경

### 정의
[질환 정의 및 병태생리]

### 병기 분류
[중증도 또는 병기 분류 체계]

### ICD 코드
- ICD-10: ${icd}
- 동의어/약어: ${synonyms.join(', ')}

---

## 2. 진료지침

### 미국 가이드라인
| 학회 | 연도 | 핵심 권고사항 | 출처 |
|------|------|------------|------|
[데이터]

### 유럽 가이드라인
| 학회 | 연도 | 핵심 권고사항 | 출처 |
|------|------|------------|------|
[데이터]

### WHO 가이드라인
[내용 또는 "WHO 공식 가이드라인 미확인"]

### 한국 가이드라인
| 학회 | 연도 | 핵심 권고사항 | 출처 |
|------|------|------------|------|
[데이터]

### 지역별 주요 차이점
[있는 경우 서술]

---

## 3. 진단법 및 치료법

### 진단 기준
[진단 알고리즘 — 검사·영상·임상 기준]

### 치료 알고리즘
**1차 치료:** [내용]
**2차 치료:** [내용]
**3차 치료 / 난치성:** [해당 시]

---

## 4. 사용 약제 현황

| 약제명(성분) | 상품명 | 계열(Class) | 허가국 | 허가연도 | 적응증 |
|------------|--------|-----------|--------|---------|--------|
[데이터]

### 약물 계열별 분류
[계열별 요약]
===END_SECTIONS===

===CONTEXT===
{
  "disease_name_ko": "${ko}",
  "disease_name_en": "${en}",
  "synonyms": [동의어 배열],
  "icd_code": "${icd}",
  "category": "질환 분류 (예: 만성 간질환)",
  "key_targets": ["주요 약물 타깃 배열"],
  "approved_drugs": ["허가 약제명 배열"],
  "search_keywords": {
    "en": ["영문 검색 키워드 3~5개"],
    "ko": ["한국어 검색 키워드 2~3개"]
  }
}
===END_CONTEXT===`;

  const response = await callClaude(SYSTEM, userPrompt, true, 10000);
  return parseClinicalResponse(response, diseaseInfo);
}

function parseClinicalResponse(text, diseaseInfo) {
  let sections = '';
  let context = null;

  const sectionsMatch = text.match(/===SECTIONS===([\s\S]*?)===END_SECTIONS===/);
  if (sectionsMatch) sections = sectionsMatch[1].trim();

  const contextMatch = text.match(/===CONTEXT===([\s\S]*?)===END_CONTEXT===/);
  if (contextMatch) {
    try {
      const raw = contextMatch[1].trim().replace(/```json|```/g, '').trim();
      context = JSON.parse(raw);
    } catch {
      context = buildDefaultContext(diseaseInfo);
    }
  } else {
    context = buildDefaultContext(diseaseInfo);
  }

  // sections가 비어있으면 전체 텍스트에서 ## 1. 부터 추출
  if (!sections) {
    const fallback = text.match(/(## 1\.[\s\S]*)/);
    sections = fallback ? fallback[1] : text;
  }

  return { sections, context };
}

function buildDefaultContext({ ko, en, icd, synonyms }) {
  return {
    disease_name_ko: ko,
    disease_name_en: en,
    synonyms,
    icd_code: icd,
    category: '',
    key_targets: [],
    approved_drugs: [],
    search_keywords: { en: [en, ...synonyms].slice(0, 4), ko: [ko] },
  };
}

module.exports = { run };
