export function shouldStartManualChat(count: number, limit: number, explicitNewChatRequired: boolean): boolean {
  return explicitNewChatRequired || (limit > 0 && count >= limit);
}

export function recordManualReply(count: number, startedNewChat: boolean): number {
  return (startedNewChat ? 0 : Math.max(0, count)) + 1;
}
