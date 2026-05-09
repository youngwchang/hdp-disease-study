const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

/**
 * Claude 호출 (web_search 도구 포함 agentic loop)
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {boolean} useWebSearch - web_search 도구 활성화 여부
 * @param {number} maxTokens
 * @returns {string} 최종 텍스트 응답
 */
async function callClaude(systemPrompt, userMessage, useWebSearch = true, maxTokens = 8000) {
  const tools = useWebSearch
    ? [{ type: 'web_search_20250305', name: 'web_search' }]
    : undefined;

  let messages = [{ role: 'user', content: userMessage }];
  let finalText = '';
  let iterations = 0;
  const MAX_ITER = 15;

  while (iterations < MAX_ITER) {
    iterations++;

    const params = {
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
    };
    if (tools) params.tools = tools;

    const response = await anthropic.messages.create(params);

    // 텍스트 블록 수집
    const textBlocks = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    if (textBlocks) finalText = textBlocks; // 마지막 텍스트로 덮어쓰기 (tool_use 후 갱신)

    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'tool_use') {
      // 어시스턴트 메시지 추가
      messages.push({ role: 'assistant', content: response.content });

      // tool_result 응답 (web_search는 Anthropic 서버가 실행)
      const toolResults = response.content
        .filter(b => b.type === 'tool_use')
        .map(b => ({
          type: 'tool_result',
          tool_use_id: b.id,
          content: '',
        }));

      messages.push({ role: 'user', content: toolResults });
    } else {
      break;
    }
  }

  return finalText;
}

module.exports = { callClaude };
