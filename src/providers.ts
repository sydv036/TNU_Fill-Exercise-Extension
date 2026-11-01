import type { AppSettings, ProviderId } from "./types";

export type { ProviderId };
export interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  mode: "api" | "manual" | "web";
  primary: boolean;
  integrationStatus: "available" | "blocked" | "not_verified" | "legacy";
  supportsImages: boolean;
  supportsAutomatedRequests: boolean;
  supportsVerifiedConversationReset: boolean;
}

export const PROVIDERS: readonly ProviderDescriptor[] = [
  { id: "chatgpt_web", label: "ChatGPT Web", mode: "web", primary: true, integrationStatus: "blocked", supportsImages: false, supportsAutomatedRequests: false, supportsVerifiedConversationReset: false },
  { id: "claude_web", label: "Claude Web", mode: "web", primary: true, integrationStatus: "blocked", supportsImages: false, supportsAutomatedRequests: false, supportsVerifiedConversationReset: false },
  { id: "gemini_web", label: "Gemini Web", mode: "web", primary: true, integrationStatus: "not_verified", supportsImages: false, supportsAutomatedRequests: false, supportsVerifiedConversationReset: false },
  { id: "deepseek_web", label: "DeepSeek Web", mode: "web", primary: true, integrationStatus: "not_verified", supportsImages: true, supportsAutomatedRequests: true, supportsVerifiedConversationReset: true },
  { id: "gemini_api", label: "Gemini API", mode: "api", primary: true, integrationStatus: "available", supportsImages: true, supportsAutomatedRequests: true, supportsVerifiedConversationReset: false },
  { id: "openai_api", label: "OpenAI API (legacy)", mode: "api", primary: false, integrationStatus: "legacy", supportsImages: true, supportsAutomatedRequests: false, supportsVerifiedConversationReset: false },
  { id: "anthropic_api", label: "Claude API (legacy)", mode: "api", primary: false, integrationStatus: "legacy", supportsImages: true, supportsAutomatedRequests: false, supportsVerifiedConversationReset: false },
  { id: "chatgpt_manual", label: "ChatGPT Web (legacy manual)", mode: "manual", primary: false, integrationStatus: "legacy", supportsImages: false, supportsAutomatedRequests: false, supportsVerifiedConversationReset: false },
  { id: "claude_manual", label: "Claude Web (legacy manual)", mode: "manual", primary: false, integrationStatus: "legacy", supportsImages: false, supportsAutomatedRequests: false, supportsVerifiedConversationReset: false },
  { id: "gemini_web_manual", label: "Gemini Web (legacy manual)", mode: "manual", primary: false, integrationStatus: "legacy", supportsImages: false, supportsAutomatedRequests: false, supportsVerifiedConversationReset: false }
];

export function getProvider(id: ProviderId): ProviderDescriptor {
  const provider = PROVIDERS.find((item) => item.id === id);
  if (!provider) throw new Error("Nhà cung cấp AI không được hỗ trợ.");
  return provider;
}
