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

  const blocks = [
    { label: '섹션 1~4 임상',        text: clinicalResult.sections, budget: 7000 },
    { label: '섹션 5 역학',          text: epi,                     budget: 5000 },
    { label: '섹션 6 시장',          text: market,                  budget: 5000 },
    { label: '섹션 7~9 파이프라인',   text: pipeline,                budget: 8000 },
  ];
  const combinedSections = blocks.map(b => b.text).join('\n\n---\n\n');

  const section10 = await writeStrategicInsights(blocks, context);

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
/**
 * 섹션별로 예산을 나눠 요약 입력을 만든다.
 *
 * 예전에는 전체를 이어붙인 뒤 substring(0, 12000) 으로 잘랐다. 그러면 앞쪽
 * 임상 섹션이 예산을 다 쓰고 시장·파이프라인이 통째로 사라진다. 정작 섹션 10 이
 * 요구하는 "경쟁 강도(파이프라인 기반)", "국내 기회(시장 기반)" 의 근거가
 * 입력에 없는 상태로 작성되던 셈이다.
 */
function buildDigest(blocks) {
  return blocks.map(({ label, text, budget }) => {
    const body = (text || '').trim();
    if (!body) return `### [${label}] 내용 없음`;
    if (body.length <= budget) return body;
    return `${body.slice(0, budget)}\n\n> (${label}: 분량 초과로 이하 생략 — 원문 ${body.length.toLocaleString()}자 중 ${budget.toLocaleString()}자 발췌)`;
  }).join('\n\n---\n\n');
}

async function writeStrategicInsights(blocks, context) {
  const system = `당신은 제약사 BD팀 전략 분석가입니다.
전체 리포트 내용을 종합하여 핵심 전략적 시사점을 한국어로 작성합니다.
BD 담당자가 의사결정에 바로 활용할 수 있는 수준으로 작성하세요.`;

  const prompt = `아래는 ${context.disease_name_ko} (${context.disease_name_en}) 분석 리포트의 전체 내용입니다.

${buildDigest(blocks)}

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

  // 3000 으로는 10-1~10-5 를 표까지 포함해 쓰기에 부족하다. 실제로 10-4·10-5 가
  // 통째로 잘려 나갔다. 한국어는 토큰이 촘촘해 같은 분량도 토큰을 더 먹는다.
  const response = await callClaude(system, prompt, false, 8000);
  const match = response.match(/===SECTION10===([\s\S]*?)===END_SECTION10===/);
  let out = match ? match[1].trim() : response.trim();

  // 종료 구분자가 없으면 응답이 중간에 끊긴 것이다. 조용히 넘기지 않는다.
  if (!match && !/10-5/.test(out)) {
    console.warn('[Orchestrator] 섹션 10 응답이 불완전합니다 (종료 구분자 없음)');
    out += '\n\n> ⚠️ 이 섹션은 생성 도중 중단되었습니다. 일부 항목(10-4·10-5)이 누락되었을 수 있습니다.';
  }
  return out;
}

module.exports = { run };
