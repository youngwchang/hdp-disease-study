const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

const HIRA_BASE = 'http://apis.data.go.kr/B551182/diseaseInfoService1';
const parser = new XMLParser({ ignoreAttributes: false });

/**
 * HIRA API로 ICD 코드 기반 환자 통계 조회
 * @param {string} icdCode - ICD-10 코드 (예: K75.81 또는 K75)
 * @param {number[]} years - 조회 연도 목록
 */
async function search(icdCode, years = [2020, 2021, 2022, 2023]) {
  const apiKey = process.env.HIRA_API_KEY;
  if (!apiKey) return { error: 'HIRA_API_KEY 미설정', ok: false, gender_age_stats: [], inout_stats: [] };

  // 상병코드 정규화 (점 제거, 3단 코드로도 시도)
  const cleanCode = icdCode.replace('.', '');
  const shortCode = cleanCode.substring(0, 3);

  const results = { icd_code: icdCode, gender_age_stats: [], inout_stats: [], errors: [] };

  // 성별·연령별 통계
  try {
    const resp = await callHIRA('getDissGndrAgInfoList1', {
      serviceKey: apiKey,
      sickType: cleanCode.length > 3 ? 2 : 1,
      medTp: 1,
      strtYear: Math.min(...years),
      endYear: Math.max(...years),
      dgsbjtCd: cleanCode,
      numOfRows: 100,
    });
    results.gender_age_stats = resp;
  } catch (e) {
    results.errors.push(`성별연령통계: ${e.message}`);
    // 3단 코드로 재시도
    try {
      const resp = await callHIRA('getDissGndrAgInfoList1', {
        serviceKey: apiKey,
        sickType: 1,
        medTp: 1,
        strtYear: Math.min(...years),
        endYear: Math.max(...years),
        dgsbjtCd: shortCode,
        numOfRows: 100,
      });
      results.gender_age_stats = resp;
    } catch (e2) {
      results.errors.push(`성별연령통계(3단): ${e2.message}`);
    }
  }

  await sleep(500);

  // 입원·외래별 통계
  try {
    const resp = await callHIRA('getDissIdrInfoList1', {
      serviceKey: apiKey,
      sickType: cleanCode.length > 3 ? 2 : 1,
      medTp: 1,
      strtYear: Math.min(...years),
      endYear: Math.max(...years),
      dgsbjtCd: cleanCode,
      numOfRows: 100,
    });
    results.inout_stats = resp;
  } catch (e) {
    results.errors.push(`입원외래통계: ${e.message}`);
  }

  results.ok = results.gender_age_stats.length > 0 || results.inout_stats.length > 0;
  return results;
}

async function callHIRA(operation, params) {
  // data.go.kr 키는 인코딩된 형태로 발급된다. axios 의 params 로 넘기면 '%' 가
  // 다시 인코딩되어(%25) 인증이 깨진다. 미리 디코딩해 이중 인코딩을 막는다.
  const safeParams = { ...params, pageNo: 1 };
  if (typeof safeParams.serviceKey === 'string' && safeParams.serviceKey.includes('%')) {
    try { safeParams.serviceKey = decodeURIComponent(safeParams.serviceKey); } catch { /* 원본 유지 */ }
  }

  const resp = await axios.get(`${HIRA_BASE}/${operation}`, {
    params: safeParams,
    timeout: 15000,
  });

  const parsed = parser.parse(resp.data);

  // data.go.kr 은 오류도 HTTP 200 으로 돌려준다. 결과코드를 보지 않으면
  // 오류 XML 을 빈 배열로 해석해 "데이터 없음" 처럼 보이게 된다.
  const svcErr = parsed?.OpenAPI_ServiceResponse?.cmmMsgHeader;
  if (svcErr) {
    throw new Error(`${svcErr.errMsg || 'API 오류'} (코드 ${svcErr.returnReasonCode}) ${svcErr.returnAuthMsg || ''}`.trim());
  }

  const header = parsed?.response?.header;
  if (header && String(header.resultCode) !== '00') {
    throw new Error(`${header.resultMsg || '조회 실패'} (resultCode ${header.resultCode})`);
  }

  const body = parsed?.response?.body;
  if (!body) throw new Error('예상과 다른 응답 형식 — 엔드포인트가 변경되었을 수 있습니다');

  const items = body?.items?.item ?? [];
  return Array.isArray(items) ? items : [items];
}

/** HIRA 데이터를 프롬프트용 텍스트로 변환 */
function formatForPrompt(hiraData) {
  if (!hiraData) {
    return 'HIRA 데이터: 조회하지 않음';
  }
  if (hiraData.error) {
    return `HIRA 데이터: ${hiraData.error}\n→ 섹션 5-2 의 HIRA 표에는 "HIRA 데이터 미확인"으로 기재하고 수치를 만들지 마세요.`;
  }
  if (!hiraData.ok) {
    const why = (hiraData.errors || []).join(' / ') || '해당 상병코드 데이터 없음';
    return `HIRA 데이터: 조회 결과 없음 (${why})\n→ 섹션 5-2 의 HIRA 표에는 "HIRA 데이터 미확인"으로 기재하고 수치를 만들지 마세요.`;
  }

  let text = '## HIRA 건강보험 청구 데이터\n';
  text += '※ 건강보험 청구 기반으로 실제 환자수와 차이 가능\n\n';

  if (hiraData.inout_stats?.length > 0) {
    text += '### 연도별 청구 현황\n';
    text += '| 연도 | 구분 | 환자수(명) | 내원일수 |\n|------|------|----------|--------|\n';
    hiraData.inout_stats.slice(0, 20).forEach(row => {
      text += `| ${row.yadmDdDesc || ''} | ${row.idrDvDesc || ''} | ${Number(row.ptCnt || 0).toLocaleString()} | ${Number(row.mdayDays || 0).toLocaleString()} |\n`;
    });
  }

  if (hiraData.gender_age_stats?.length > 0) {
    text += '\n### 성별·연령별 분포 (최근 데이터)\n';
    text += '| 성별 | 연령대 | 환자수(명) |\n|------|--------|----------|\n';
    hiraData.gender_age_stats.slice(0, 20).forEach(row => {
      text += `| ${row.gndrDesc || ''} | ${row.ageDesc || ''} | ${Number(row.ptCnt || 0).toLocaleString()} |\n`;
    });
  }

  return text;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { search, formatForPrompt };
