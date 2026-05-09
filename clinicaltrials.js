const axios = require('axios');

const CT_BASE = 'https://clinicaltrials.gov/api/v2/studies';

/**
 * ClinicalTrials.gov 임상시험 검색
 * @param {string} condition - 질환명
 * @param {string[]} phases - ['PHASE2', 'PHASE3'] 등
 * @param {string[]} statuses - ['RECRUITING', 'ACTIVE_NOT_RECRUITING'] 등
 * @param {number} maxResults
 */
async function search(condition, phases = [], statuses = [], maxResults = 30) {
  try {
    const params = {
      'query.cond': condition,
      pageSize: maxResults,
      format: 'json',
      fields: 'NCTId,BriefTitle,OfficialTitle,LeadSponsorName,Phase,OverallStatus,PrimaryOutcomeMeasure,CompletionDate,EnrollmentCount,InterventionName,InterventionType',
    };

    if (phases.length > 0) params['filter.phase'] = phases.join(',');
    if (statuses.length > 0) params['filter.overallStatus'] = statuses.join(',');

    const resp = await axios.get(CT_BASE, { params, timeout: 20000 });
    const studies = resp.data?.studies || [];
    return studies.map(parseStudy);
  } catch (err) {
    console.warn(`[ClinicalTrials] 검색 실패 (${condition}):`, err.message);
    return [];
  }
}

function parseStudy(study) {
  const proto = study?.protocolSection || {};
  const id = proto?.identificationModule || {};
  const status = proto?.statusModule || {};
  const design = proto?.designModule || {};
  const sponsor = proto?.sponsorCollaboratorsModule || {};
  const outcomes = proto?.outcomesModule || {};
  const interventions = proto?.armsInterventionsModule?.interventions || [];

  const drugs = interventions
    .filter(i => i.type === 'DRUG' || i.type === 'BIOLOGICAL')
    .map(i => i.name)
    .slice(0, 3);

  const primaryEndpoint = (outcomes?.primaryOutcomes || [])
    .slice(0, 2)
    .map(o => o.measure)
    .join('; ');

  return {
    nctId: id.nctId || '',
    title: id.briefTitle || '',
    sponsor: sponsor?.leadSponsor?.name || '',
    drugs,
    phase: (design?.phases || []).join(', '),
    status: status?.overallStatus || '',
    primaryEndpoint: primaryEndpoint.substring(0, 200),
    completionDate: status?.completionDateStruct?.date || '',
    enrollment: design?.enrollmentInfo?.count || '',
    url: `https://clinicaltrials.gov/study/${id.nctId}`,
  };
}

/** 임상시험 목록을 프롬프트용 텍스트로 변환 */
function formatForPrompt(trials) {
  if (!trials || trials.length === 0) return '임상시험 데이터: 검색 결과 없음';

  const header = '| 약물명 | 개발사 | Phase | 상태 | 주요 엔드포인트 | 완료 예정 | NCT ID |\n|--------|--------|-------|------|----------------|----------|--------|\n';
  const rows = trials.map(t =>
    `| ${(t.drugs.join(', ') || t.title.substring(0, 30))} | ${t.sponsor} | ${t.phase} | ${t.status} | ${t.primaryEndpoint.substring(0, 60)} | ${t.completionDate} | ${t.nctId} |`
  ).join('\n');

  return header + rows;
}

module.exports = { search, formatForPrompt };
