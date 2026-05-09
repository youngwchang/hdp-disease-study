const { callClaude } = require('../lib/claude');

const SYSTEM = `당신은 제약사 BD팀의 전문 시장 분석가입니다.
질환 치료제 시장 규모·전망·주요 약제 매출을 분석합니다.
- 모든 수치에 출처와 연도를 명시하세요.
- 여러 리포트의 수치가 다를 경우 범위로 제시하고 채택 근거를 밝히세요.
- IQVIA 데이터가 제공된 경우 핵심 수치와 전략적 인사이트를 반드시 추출하세요.
- 마크다운 테이블 형식을 사용하세요.`;

async function run(context, iqviaData, emit) {
  emit('Market Agent: 시장 데이터 분석 중...');

  const { disease_name_ko: ko, disease_name_en: en, approved_drugs: drugs = [] } = context;

  const iqviaSection = formatIqvia(iqviaData);

  const userPrompt = `## 분석 대상 질환
- 한국어명: ${ko}
- 영문명: ${en}
- 주요 허가 약제: ${drugs.join(', ') || '웹 검색으로 확인'}

## IQVIA 데이터
${iqviaSection}

## 웹 검색 수집 지침
다음을 웹 검색으로 수집하세요:
- 글로벌 시장 규모: "${en} market size USD billion 2023 2024 forecast CAGR"
- 국내 시장: "${ko} 치료제 시장 규모 한국 국내"
- 약제 매출: 각 허가 약제별 연간 매출 (기업 IR 또는 언론 보도 기준)
- 성장 동인: "${en} market growth drivers unmet need 2024 2025"
- "${en} pharmaceutical market GlobalData OR EvaluatePharma OR IQVIA"

## 출력 형식

===SECTION6===
## 6. 치료제 시장 규모 및 전망

### 6-1. 글로벌 시장 규모
| 연도 | 시장 규모 | 통화 | 출처 |
|------|---------|------|------|
[데이터]

**CAGR**: [연평균 성장률]% (기간: , 출처: )
**추정치 범위**: [최솟값] ~ [최댓값] (리포트별 차이 원인: )

### 6-2. 국내 시장 규모
[수치 또는 "공개 데이터 없음 — 글로벌 시장 대비 약 2~3% 수준 추정"]

### 6-3. IQVIA 데이터 분석
[IQVIA 데이터 있으면 핵심 수치 및 인사이트 / 없으면 "IQVIA 데이터 미제공"]

### 6-4. 주요 허가 약제 매출 현황
| 약제명 | 개발사 | 연도 | 매출액 | 통화 | 출처 |
|--------|--------|------|--------|------|------|
[데이터]

### 6-5. 시장 성장 동인 및 저해 요인
**성장 동인:**
- [동인 서술]

**저해 요인:**
- [요인 서술]
===END_SECTION6===`;

  const response = await callClaude(SYSTEM, userPrompt, true, 6000);
  return parseSection(response);
}

function formatIqvia(iqviaData) {
  if (!iqviaData || Object.keys(iqviaData).length === 0) {
    return 'IQVIA 데이터 미제공 — 파일 없음';
  }

  let text = '### 제공된 IQVIA 시트 데이터\n';
  for (const [sheetName, rows] of Object.entries(iqviaData)) {
    if (!Array.isArray(rows) || rows.length === 0) continue;
    text += `\n#### 시트: ${sheetName}\n`;
    // 헤더행 + 최대 30행만 포함
    const preview = rows.slice(0, 31);
    preview.forEach((row, i) => {
      const rowArr = Array.isArray(row) ? row : Object.values(row);
      text += `| ${rowArr.map(c => String(c ?? '').substring(0, 40)).join(' | ')} |\n`;
      if (i === 0) text += `| ${rowArr.map(() => '---').join(' | ')} |\n`;
    });
  }
  return text;
}

function parseSection(text) {
  const match = text.match(/===SECTION6===([\s\S]*?)===END_SECTION6===/);
  if (match) return match[1].trim();
  const fallback = text.match(/(## 6\.[\s\S]*)/);
  return fallback ? fallback[1].trim() : text.trim();
}

module.exports = { run };
