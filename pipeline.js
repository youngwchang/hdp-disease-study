const { callClaude } = require('../lib/claude');
const pubmed = require('../lib/pubmed');
const clinicaltrials = require('../lib/clinicaltrials');

const SYSTEM = `당신은 제약사 BD팀의 전문 파이프라인 분석가입니다.
개발 중인 의약품, 임상시험 현황, 주요 개발사를 분석합니다.
- ClinicalTrials.gov 데이터를 기반으로 파이프라인 테이블을 작성하세요.
- 해당 질환과 관련 없는 시험은 제외하세요.
- 주요 개발사 3~5개를 심층 분석하세요.
- 마크다운 테이블 형식을 사용하세요.`;

async function run(context, emit) {
  emit('Pipeline Agent: ClinicalTrials.gov 검색 중...');

  const { disease_name_ko: ko, disease_name_en: en, synonyms = [], key_targets = [] } = context;

  // ClinicalTrials 검색 (Phase2+3 모집 중 + 완료)
  const [activeTrials, completedTrials, phase1Trials] = await Promise.all([
    clinicaltrials.search(en, ['PHASE2', 'PHASE3'], ['RECRUITING', 'ACTIVE_NOT_RECRUITING'], 30),
    clinicaltrials.search(en, ['PHASE3'], ['COMPLETED'], 15),
    clinicaltrials.search(en, ['PHASE1', 'PHASE2'], ['RECRUITING'], 15),
  ]);

  // 동의어 추가 검색 (첫 번째와 다른 경우)
  let synonymTrials = [];
  const altKeyword = synonyms.find(s => s.toLowerCase() !== en.toLowerCase());
  if (altKeyword) {
    synonymTrials = await clinicaltrials.search(altKeyword, ['PHASE2', 'PHASE3'], [], 20);
  }

  // NCT ID 기준 중복 제거
  const allTrials = deduplicateTrials([...activeTrials, ...completedTrials, ...synonymTrials, ...phase1Trials]);

  // 최근 허가·파이프라인 보완용 PubMed
  const recentPapers = await pubmed.search(`${en} new drug approval clinical trial 2022 2023 2024`, 5);

  emit('Pipeline Agent: Claude 분석 중 (파이프라인·개발사 섹션)...');

  const userPrompt = `## 분석 대상 질환
- 한국어명: ${ko}
- 영문명: ${en}
- 동의어: ${synonyms.join(', ')}
- 주요 약물 타깃(MOA): ${key_targets.join(', ') || '웹 검색으로 확인'}

## ClinicalTrials.gov 검색 결과 (총 ${allTrials.length}건)

### Phase 2·3 진행 중
${clinicaltrials.formatForPrompt(activeTrials)}

### Phase 3 완료
${clinicaltrials.formatForPrompt(completedTrials)}

### Phase 1·2 진행 중
${clinicaltrials.formatForPrompt(phase1Trials)}

## PubMed 최근 허가·임상 논문
${pubmed.formatForPrompt(recentPapers, '최근허가')}

## 웹 검색 보완 지침
다음을 웹 검색으로 반드시 보완하세요:
- 최근 3년 FDA/EMA 허가·실패 이벤트: "${en} FDA approved NDA 2022 2023 2024"
- 국내 임상: "${ko} 임상시험 식약처 IND 승인"
- 주요 개발사 프로파일 (ClinicalTrials 결과에서 상위 스폰서 선정)
- 파이프라인 MOA 및 최신 데이터 발표

## 출력 형식

===SECTION789===
## 7. 개발 중인 의약품 파이프라인

### 7-1. 파이프라인 현황 테이블
| 약물명 | 개발사 | MOA | Phase | 주요 엔드포인트 | 예상 완료 | 상태 |
|--------|--------|-----|-------|--------------|---------|------|
[ClinicalTrials 데이터 기반, 해당 질환 관련 건만 포함]

> 출처: ClinicalTrials.gov

### 7-2. 단계별 요약
| Phase | 시험 수 | 주요 MOA/타깃 |
|-------|--------|-------------|
[집계]

### 7-3. 경쟁 강도 평가
[파이프라인 포화도, 주요 MOA 중복 여부, 진입 기회 분석]

---

## 8. 임상시험 승인 현황

### 8-1. 글로벌 진행 중 임상시험
[RECRUITING + ACTIVE 주요 시험 요약]

### 8-2. 국내 임상시험 현황
[식약처 IND 승인 현황 또는 "식약처 IND 승인 정보 미확인"]

### 8-3. 최근 3년 주요 이벤트
| 연도 | 이벤트 | 약물명 | 기관 | 결과 |
|------|--------|--------|------|------|
[허가/실패/CRL 등]

---

## 9. 주요 신약 개발사 분석

### 9-1. 주요 플레이어 목록
| 회사명 | 유형 | 주요 파이프라인 | 단계 | 비고 |
|--------|------|--------------|------|------|
[상위 3~5개]

### 9-2. 개발사별 상세 프로파일
[상위 3~5개 회사 각각 서술]

### 9-3. 국내 기업 현황
[국내 개발사 파이프라인 또는 "국내 개발사 파이프라인 미확인"]
===END_SECTION789===`;

  const response = await callClaude(SYSTEM, userPrompt, true, 8000);
  return parseSection(response);
}

function deduplicateTrials(trials) {
  const seen = new Set();
  return trials.filter(t => {
    if (seen.has(t.nctId)) return false;
    seen.add(t.nctId);
    return true;
  });
}

function parseSection(text) {
  const match = text.match(/===SECTION789===([\s\S]*?)===END_SECTION789===/);
  if (match) return match[1].trim();
  const fallback = text.match(/(## 7\.[\s\S]*)/);
  return fallback ? fallback[1].trim() : text.trim();
}

module.exports = { run };
