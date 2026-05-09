const { callClaude } = require('./lib/claude');
const clinicalAgent = require('./agents/clinical');
const epidemiologyAgent = require('./agents/epidemiology');
const marketAgent = require('./agents/market');
const pipelineAgent = require('./agents/pipeline');

const NORMALIZE_SYSTEM = `당신은 의학 전문가입니다. 입력된 질환명을 표준화합니다.
반드시 아래 JSON 형식만 출력하세요 (다른 텍스트 없이).`;

/**
 * 전체 분석 실행
 * @param {string} jobId
 * @param {string} rawDisease - 사용자 입력 질환명
 * @param {object|null} iqviaData - 프론트엔드에서 파싱된 IQVIA JSON
 * @param {function} emit - 진행 상황 전송 함수
 * @returns {{ markdown: string, title: string }}
 */
async function run(jobId, rawDisease, iqviaData, emit) {
  // ── STEP 0: 질환명 정제 ──────────────────────────────
  emit({ step: 0, message: '질환명 정제 중...' });

  const diseaseInfo = await normalizeDisease(rawDisease);
  emit({ step: 0, message: `질환 확인: ${diseaseInfo.ko} (${diseaseInfo.en}, ${diseaseInfo.icd})` });

  // ── STEP 1: Clinical Agent (선행·순차) ───────────────
  emit({ step: 1, message: '임상 정보 수집 시작...' });

  const clinicalResult = await clinicalAgent.run(diseaseInfo, msg => emit({ step: 1, message: msg }));
  const context = clinicalResult.context;

  emit({ step: 1, message: '임상 섹션(1~4) 완료 ✓' });

  // ── STEP 2: 병렬 에이전트 ───────────────────────────
  emit({ step: 2, message: '역학·시장·파이프라인 병렬 수집 시작...' });

  const [epiSection, marketSection, pipelineSection] = await Promise.allSettled([
    epidemiologyAgent.run(context, msg => emit({ step: 2, message: msg })),
    marketAgent.run(context, iqviaData, msg => emit({ step: 2, message: msg })),
    pipelineAgent.run(context, msg => emit({ step: 2, message: msg })),
  ]);

  const epi = epiSection.status === 'fulfilled' ? epiSection.value
    : '## 5. 역학 데이터\n> ⚠️ 수집 실패 — 데이터 미확인\n';
  const market = marketSection.status === 'fulfilled' ? marketSection.value
    : '## 6. 치료제 시장 규모 및 전망\n> ⚠️ 수집 실패 — 데이터 미확인\n';
  const pipeline = pipelineSection.status === 'fulfilled' ? pipelineSection.value
    : '## 7. 개발 중인 의약품 파이프라인\n> ⚠️ 수집 실패 — 데이터 미확인\n\n## 8. 임상시험 승인 현황\n> ⚠️ 수집 실패\n\n## 9. 주요 신약 개발사 분석\n> ⚠️ 수집 실패\n';

  emit({ step: 2, message: '병렬 수집 완료 ✓' });

  // ── STEP 3: 통합 + 섹션 10 작성 ─────────────────────
  emit({ step: 3, message: '리포트 통합 및 전략적 시사점 작성 중...' });

  const combinedSections = [
    clinicalResult.sections,
    epi,
    market,
    pipeline,
  ].join('\n\n---\n\n');

  const section10 = await writeStrategicInsights(combinedSections, context);

  emit({ step: 3, message: '섹션 10(전략적 시사점) 완료 ✓' });

  // ── 최종 리포트 조립 ─────────────────────────────────
  const today = new Date().toLocaleDateString('ko-KR');
  const reportTitle = `${context.disease_name_ko} (${context.disease_name_en}) 질환 정보 분석 리포트`;

  const markdown = `# ${reportTitle}

> **생성일**: ${today}  
> **ICD-10**: ${context.icd_code}  
> **질환 분류**: ${context.category || '–'}  
> **주요 동의어**: ${(context.synonyms || []).join(', ') || '–'}

---

${combinedSections}

---

${section10}

---

*본 리포트는 AI 기반 자동 수집 시스템으로 생성되었습니다. 임상적 의사결정에 사용하기 전 반드시 원문 자료를 확인하세요.*
`;

  emit({ step: 3, message: '리포트 생성 완료 ✓' });

  return { markdown, title: reportTitle };
}

/** 질환명 정제 */
async function normalizeDisease(rawDisease) {
  const prompt = `다음 질환명을 표준화하여 JSON으로만 응답하세요:
입력: "${rawDisease}"

출력 형식:
{
  "ko": "한국어 공식명",
  "en": "English official name",
  "icd": "ICD-10 code (예: K75.81)",
  "synonyms": ["동의어1", "약어1"]
}`;

  try {
    const raw = await callClaude(NORMALIZE_SYSTEM, prompt, false, 500);
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      ko: parsed.ko || rawDisease,
      en: parsed.en || rawDisease,
      icd: parsed.icd || 'Unknown',
      synonyms: parsed.synonyms || [],
    };
  } catch {
    return { ko: rawDisease, en: rawDisease, icd: 'Unknown', synonyms: [] };
  }
}

/** 섹션 10 — 전략적 시사점 */
async function writeStrategicInsights(allSections, context) {
  const system = `당신은 제약사 BD팀 전략 분석가입니다.
전체 리포트 내용을 종합하여 핵심 전략적 시사점을 한국어로 작성합니다.
BD 담당자가 의사결정에 바로 활용할 수 있는 수준으로 작성하세요.`;

  const prompt = `아래는 ${context.disease_name_ko} (${context.disease_name_en}) 분석 리포트의 전체 내용입니다.

${allSections.substring(0, 12000)}

## 작성 지침
전체 내용을 종합하여 아래 5개 항목의 전략적 시사점을 작성하세요.

===SECTION10===
## 10. 전략적 시사점 요약

### 10-1. Unmet Need 규모
[역학 데이터 + 현재 치료 한계 기반으로 미충족 의료 수요 분석]

### 10-2. 경쟁 강도 평가
[파이프라인 현황 기반 — 현재 경쟁 수준과 진입 난이도]

### 10-3. 국내 기회 요인
[국내 역학 + 시장 규모 + 급여 환경 기반]

### 10-4. 시장 진입 타이밍 권고
- **권고**: 조기진입 / 적시진입 / 지연진입 중 선택
- **근거**: [파이프라인 단계·시장 성장률·경쟁 상황 기반]

### 10-5. 핵심 리스크
- [리스크 1]: [설명]
- [리스크 2]: [설명]
- [리스크 3]: [설명]
===END_SECTION10===`;

  const response = await callClaude(system, prompt, false, 3000);
  const match = response.match(/===SECTION10===([\s\S]*?)===END_SECTION10===/);
  return match ? match[1].trim() : response.trim();
}

module.exports = { run };
