import { defineConfig } from "wxt";

export default defineConfig({
  outDir: process.env.TNU_RELEASE_DIR || ".output",
  modules: ["@wxt-dev/module-react"],
  vite: () => ({
    build: { assetsInlineLimit: 0 }
  }),
  manifest: {
    name: "TNU Fill Exercise Assistant",
    description: "Hỗ trợ luyện tập Moodle TNU với Gemini API và tab Gemini, ChatGPT, Claude hoặc DeepSeek Web; có chế độ luyện đến điểm tối đa.",
    version: "3.5.4",
    minimum_chrome_version: "114",
    permissions: ["storage", "tabs", "sidePanel", "notifications"],
    host_permissions: [
      "https://tnu.aum.edu.vn/*",
      "https://gemini.google.com/*",
      "https://chatgpt.com/*",
      "https://chat.openai.com/*",
      "https://claude.ai/*",
      "https://chat.deepseek.com/*",
      "http://127.0.0.1/*",
      "http://localhost/*",
      "https://generativelanguage.googleapis.com/*"
    ],
    web_accessible_resources: [{
      resources: ["assets/*.mjs"],
      matches: ["https://tnu.aum.edu.vn/*"]
    }],
    action: {
      default_title: "Mở TNU Gemini Assistant"
    },
    side_panel: {
      default_path: "sidepanel.html"
    },
    icons: {
      "16": "icon-16.png",
      "48": "icon-48.png",
      "128": "icon-128.png"
    }
  }
});
