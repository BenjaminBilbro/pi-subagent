console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({
  type: "agent_end",
  messages: [{
    role: "assistant",
    content: [{ type: "text", text: "I forgot the structured receipt." }],
    model: "fixture-model",
    stopReason: "stop",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
    timestamp: Date.now(),
  }],
}));
console.log(JSON.stringify({ type: "agent_settled" }));
