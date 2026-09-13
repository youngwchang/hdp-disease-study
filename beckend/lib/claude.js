const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';  // 원본 값 유지

// 검색 상한 — 에이전트 4개가 병렬로 돌아 상한이 없으면 토큰이 예측 불가능해진다
const MAX_SEARCHES = Number(process.env.MAX_WEB_SEARCHES || 12);
const MAX_ITER = 15;
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 일시적 API 오류에 지수 백오프 재시도 */
async function createWithRetry(params, label) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await anthropic.messages.create(params);
    } catch (err) {
      const status = err?.status ?? err?.response?.status;
      if (!RETRYABLE.has(status) || attempt === 3) throw err;
      const delay = 2000 * 2 ** attempt;
      console.warn(`[Claude] ${label} ${status} — ${delay / 1000}초 후 재시도 (${attempt + 1}/3)`);
      await sleep(delay);
    }
  }
}

/**
 * Claude 호출 (web_search 서버 도구 포함)
 *
 * web_search 는 Anthropic 서버가 직접 실행하는 도구다. 검색 결과가 같은 응답
 * 안에 들어오므로 클라이언트가 tool_result 를 돌려줄 필요가 없다.
 * 대신 검색이 길어지면 stop_reason 이 'pause_turn' 으로 끊기는데, 이때는
 * 지금까지의 응답을 그대로 다시 넣어 이어가야 한다. 이 처리가 없으면
 * 섹션이 문장 중간에서 끊긴 채 반환된다.
 *
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {boolean} useWebSearch
 * @param {number} maxTokens
 * @returns {string} 최종 텍스트 응답
 */
async function callClaude(systemPrompt, userMessage, useWebSearch = true, maxTokens = 8000) {
  const tools = useWebSearch
    ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_SEARCHES }]
    : undefined;

  const messages = [{ role: 'user', content: userMessage }];
  const chunks = [];
  let iterations = 0;
  let truncated = false;

  while (iterations < MAX_ITER) {
    iterations++;

    const params = { model: MODEL, max_tokens: maxTokens, system: systemPrompt, messages };
    if (tools) params.tools = tools;

    const response = await createWithRetry(params, `iter${iterations}`);

    const textBlocks = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');
    if (textBlocks) chunks.push(textBlocks);

    if (response.stop_reason === 'pause_turn') {
      // 서버 도구 실행이 길어져 일시 중단됨 — 응답을 그대로 넣고 이어간다
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }

    if (response.stop_reason === 'max_tokens') {
      truncated = true;
      console.warn(`[Claude] 응답이 max_tokens(${maxTokens})에 걸려 잘렸습니다`);
      break;
    }

    if (response.stop_reason === 'tool_use') {
      // 서버 도구만 쓰므로 여기 오면 안 된다. 빈 tool_result 를 보내면
      // 모델이 검색 결과가 비었다고 받아들이므로 그냥 중단한다.
      console.warn('[Claude] 예상치 못한 stop_reason=tool_use — 클라이언트 도구가 설정되었는지 확인하세요');
      break;
    }

    break; // end_turn 등
  }

  if (iterations >= MAX_ITER) {
    console.warn(`[Claude] 반복 상한(${MAX_ITER})에 도달했습니다`);
  }

  let finalText = chunks.join('\n').trim();
  if (truncated) {
    finalText += '\n\n> ⚠️ 이 섹션은 응답 길이 제한으로 중간에 중단되었습니다.';
  }
  return finalText;
}

module.exports = { callClaude };
