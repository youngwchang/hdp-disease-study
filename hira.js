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
  if (!apiKey) return { error: 'HIRA_API_KEY 미설정', gender_age_stats: [], inout_stats: [] };

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

  return results;
}

async function callHIRA(operation, params) {
  const resp = await axios.get(`${HIRA_BASE}/${operation}`, {
    params: { ...params, pageNo: 1 },
    timeout: 15000,
  });

  const parsed = parser.parse(resp.data);
  const items = parsed?.response?.body?.items?.item || [];
  return Array.isArray(items) ? items : [items];
}

/** HIRA 데이터를 프롬프트용 텍스트로 변환 */
function formatForPrompt(hiraData) {
  if (!hiraData || hiraData.errors?.length > 0 && hiraData.gender_age_stats?.length === 0) {
    return `HIRA 데이터: API 조회 실패 또는 해당 코드 데이터 없음\n오류: ${(hiraData?.errors || []).join(', ')}`;
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
