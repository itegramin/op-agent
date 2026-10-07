export class Provider {
  constructor(config) { this.config = config; }
  async complete(system, messages, tools) {
    const { provider, model, apiKey, baseUrl } = this.config;
    if (!apiKey) throw new Error(`Set ${provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} before starting a conversation.`);
    const anthropic = provider === 'anthropic';
    const body = anthropic ? {
      model, system, max_tokens: 4096,
      messages: messages.map(m => {
        if (m.role === 'tool') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.id, content: m.content }] };
        if (m.role === 'assistant') return { role: 'assistant', content: [
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ...(m.calls || []).map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
        ] };
        return m;
      }),
      tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    } : {
      model,
      messages: [{ role: 'system', content: system }, ...messages.map(m => {
        if (m.role === 'tool') return { role: 'tool', tool_call_id: m.id, content: m.content };
        if (m.role === 'assistant') return { role: 'assistant', content: m.content || null,
          ...(m.calls?.length ? { tool_calls: m.calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}) };
        return m;
      })],
      tools: tools.map(t => ({ type: 'function', function: t })),
    };
    // Anthropic requires all results for a tool-use turn in the same user message.
    if (anthropic) body.messages = body.messages.reduce((all, m) => {
      const last = all.at(-1);
      if (m.role === 'user' && Array.isArray(m.content) && last?.role === 'user' && Array.isArray(last.content)) last.content.push(...m.content);
      else all.push(m);
      return all;
    }, []);
    const response = await fetch(`${baseUrl}/${anthropic ? 'messages' : 'chat/completions'}`, {
      method: 'POST', signal: AbortSignal.timeout(120000),
      headers: { 'content-type': 'application/json', ...(anthropic ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${apiKey}` }) },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const hint = response.status === 401 ? 'Check your API key.' : response.status === 429 ? 'Rate limit or quota reached; try again later.' : 'Check your endpoint and model configuration.';
      throw new Error(`API request failed (${response.status}). ${hint}`);
    }
    const data = await response.json();
    if (anthropic) {
      if (!Array.isArray(data.content)) throw new Error('Invalid Anthropic response.');
      if (data.stop_reason === 'max_tokens') throw new Error('Model output was truncated; shorten the request. No tools from this response were executed.');
      return { content: data.content.filter(b => b.type === 'text').map(b => b.text).join('\n'), calls: data.content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input })) };
    }
    const choice = data.choices?.[0];
    if (!choice?.message) throw new Error('Invalid OpenAI-compatible response.');
    if (choice.finish_reason === 'length') throw new Error('Model output was truncated; shorten the request. No tools from this response were executed.');
    return { content: choice.message.content || '', calls: (choice.message.tool_calls || []).map(c => ({ id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments) })) };
  }
}
